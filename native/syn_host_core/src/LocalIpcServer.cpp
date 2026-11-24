#include "syn_host/LocalIpcServer.hpp"
#include "syn_host/AudioRouter.hpp"

#include <cctype>
#include <chrono>
#include <sstream>
#include <thread>

#ifdef SYN_HAS_IXWEBSOCKET
#include <ixwebsocket/IXHttpServer.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocketServer.h>
#include <nlohmann/json.hpp>
#endif

namespace syn::host {

#ifdef SYN_HAS_IXWEBSOCKET
namespace {

nlohmann::json serializeInstanceJson(const PluginInstanceInfo& info) {
  nlohmann::json params = nlohmann::json::array();
  for (const auto& p : info.parameters) {
    params.push_back({
        {"id", p.id},
        {"name", p.name},
        {"label", p.label},
        {"valueNormalized", p.valueNormalized},
        {"defaultValueNormalized", p.defaultValueNormalized},
        {"stepCount", p.stepCount},
        {"isAutomatable", p.isAutomatable},
        {"isReadOnly", p.isReadOnly},
        {"isBypass", p.isBypass},
        {"displayValue", p.displayValue},
    });
  }
  return {
      {"instanceId", info.instanceId},
      {"uid", info.uid},
      {"bundlePath", info.bundlePath},
      {"name", info.name},
      {"manufacturer", info.manufacturer},
      {"sampleRate", info.sampleRate},
      {"blockSize", info.blockSize},
      {"channels", info.channels},
      {"latencySamples", info.latencySamples},
      {"bypassed", info.bypassed},
      {"hasEditor", info.hasEditor},
      {"editorOpen", info.editorOpen},
      {"active", info.active},
      {"crashed", info.crashed},
      {"workerEngine", info.workerEngine},
      {"lastError", info.lastError},
      {"parameters", params},
  };
}

} // namespace
#endif

std::string LocalIpcServer::serializePluginJson(const PluginDescriptor& d) {
#ifdef SYN_HAS_IXWEBSOCKET
  nlohmann::json buses = nlohmann::json::array();
  for (const auto& b : d.busConfigs) {
    buses.push_back({
        {"layoutName", b.layoutName},
        {"mainInputChannels", b.mainInputChannels},
        {"mainOutputChannels", b.mainOutputChannels},
        {"sidechainInputChannels", b.sidechainInputChannels},
    });
  }

  nlohmann::json params = nlohmann::json::array();
  for (const auto& p : d.parameters) {
    nlohmann::json obj = {
        {"id", p.id},
        {"name", p.name},
        {"label", p.label},
        {"defaultValueNormalized", p.defaultValueNormalized},
        {"stepCount", p.stepCount},
        {"isAutomatable", p.isAutomatable},
        {"isReadOnly", p.isReadOnly},
        {"isBypass", p.isBypass},
    };
    if (!p.extJson.empty()) {
      try {
        auto ext = nlohmann::json::parse(p.extJson);
        if (ext.is_object()) {
          for (auto it = ext.begin(); it != ext.end(); ++it) {
            if (!obj.contains(it.key())) obj[it.key()] = it.value();
          }
        }
      } catch (...) {}
    }
    params.push_back(std::move(obj));
  }

  nlohmann::json j = {
      {"uid", d.uid},
      {"format", toString(d.format)},
      {"name", d.name},
      {"manufacturer", d.manufacturer},
      {"version", d.version},
      {"sdkVersion", d.sdkVersion},
      {"category", d.category},
      {"subCategories", d.subCategories},
      {"bundlePath", d.bundlePath},
      {"binaryPath", d.binaryPath},
      {"arch", toString(d.arch)},
      {"status", toString(d.status)},
      {"statusReason", d.statusReason},
      {"hasEditor", d.hasEditor},
      {"latencySamples", d.latencySamples},
      {"busConfigs", buses},
      {"parameterCount", d.parameterCount},
      {"parameters", params},
      {"fileMtimeNs", d.fileMtimeNs},
      {"fileSizeBytes", d.fileSizeBytes},
      {"fileHashSha256", d.fileHashSha256},
      {"failCount", d.failCount},
      {"lastScannedAt", d.lastScannedAt},
      {"favorite", d.favorite},
      {"lastUsedAt", d.lastUsedAt},
      {"disabledByUser", d.disabledByUser},
  };
  return j.dump();
#else
  (void)d;
  return "{}";
#endif
}

#ifdef SYN_HAS_IXWEBSOCKET
struct ClientConnState : public ix::ConnectionState {
  bool authenticated = false;
  std::string origin;
};

struct LocalIpcServer::Impl {
  std::unique_ptr<ix::HttpServer> httpServer;
  std::unique_ptr<ix::WebSocketServer> wsServer;
  std::mutex wsMutex;
  std::unordered_set<ix::WebSocket*> clients;
};
#else
struct LocalIpcServer::Impl {};
#endif

LocalIpcServer::LocalIpcServer(
    HostServerConfig config,
    PluginCatalogDb& db,
    SecurityPolicy& security,
    PluginInstanceManager* instanceManager,
    WasapiDeviceManager* audioManager)
    : m_config(std::move(config)),
      m_db(db),
      m_security(security),
      m_instanceManager(instanceManager),
      m_audioManager(audioManager),
      m_impl(std::make_unique<Impl>()) {}

LocalIpcServer::~LocalIpcServer() {
  stop();
}

void LocalIpcServer::setScanHandler(ScanTriggerCallback cb) {
  m_scanHandler = std::move(cb);
}

bool LocalIpcServer::startScan(const std::string& modeIn) {
#ifdef SYN_HAS_IXWEBSOCKET
  std::string mode = modeIn;
  if (mode != "incremental" && mode != "full" && mode != "force") mode = "incremental";
  if (!m_scanHandler) return false;
  if (m_scanInProgress.exchange(true)) return false;
  m_scanDone = 0;
  m_scanTotal = 0;
  std::thread([this, mode]() {
    m_scanHandler(mode, "", [this](int done, int total, const std::string& b, const std::string& st) {
      m_scanDone = done;
      m_scanTotal = total;
      broadcastNotification("catalog.scanProgress", nlohmann::json({
          {"completed", done},
          {"total", total},
          {"currentBundle", b},
          {"status", st},
      }).dump());
    });
    m_scanInProgress = false;
  }).detach();
  return true;
#else
  (void)modeIn;
  return false;
#endif
}

void LocalIpcServer::setShutdownHandler(std::function<void()> cb) {
  m_shutdownHandler = std::move(cb);
}

bool LocalIpcServer::start(std::string& errorOut) {
#ifndef SYN_HAS_IXWEBSOCKET
  errorOut = "IXWebSocket not enabled at compile time";
  return false;
#else
  ix::initNetSystem();

  // Strictly bind to IPv4 loopback 127.0.0.1 only
  m_impl->httpServer = std::make_unique<ix::HttpServer>(m_config.httpPort, "127.0.0.1");
  m_impl->wsServer = std::make_unique<ix::WebSocketServer>(m_config.wsPort, "127.0.0.1");

  auto getHeaderCI = [](const ix::WebSocketHttpHeaders& hdrs, const std::string& target) -> std::string {
    std::string targetLow = target;
    for (char& c : targetLow) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    for (const auto& [k, v] : hdrs) {
      std::string kl = k;
      for (char& c : kl) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      if (kl == targetLow) return v;
    }
    return {};
  };

  auto applyCorsPna = [&](ix::WebSocketHttpHeaders& outHeaders, const std::string& origin) {
    if (!origin.empty() && m_security.isOriginAllowed(origin)) {
      outHeaders["Access-Control-Allow-Origin"] = origin;
      outHeaders["Vary"] = "Origin";
    }
    outHeaders["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    outHeaders["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    outHeaders["Access-Control-Allow-Private-Network"] = "true";
    outHeaders["Content-Type"] = "application/json; charset=utf-8";
  };

  auto isBearerAuthorized = [&](const ix::WebSocketHttpHeaders& hdrs) -> bool {
    std::string auth = getHeaderCI(hdrs, "authorization");
    const std::string prefix = "Bearer ";
    if (auth.rfind(prefix, 0) != 0) return false;
    std::string tok = auth.substr(prefix.size());
    return !tok.empty() && SecurityPolicy::constantTimeEquals(tok, m_config.sessionToken);
  };

  m_impl->httpServer->setOnConnectionCallback(
      [this, getHeaderCI, applyCorsPna, isBearerAuthorized](
          ix::HttpRequestPtr req,
          std::shared_ptr<ix::ConnectionState>) -> ix::HttpResponsePtr {
        std::string origin = getHeaderCI(req->headers, "origin");
        ix::WebSocketHttpHeaders respHeaders;

        if (!origin.empty() && !m_security.isOriginAllowed(origin)) {
          respHeaders["Content-Type"] = "application/json";
          return std::make_shared<ix::HttpResponse>(
              403, "Forbidden", ix::HttpErrorCode::Ok, respHeaders,
              nlohmann::json({{"error", "Origin not authorized"}}).dump());
        }

        applyCorsPna(respHeaders, origin);

        if (req->method == "OPTIONS") {
          return std::make_shared<ix::HttpResponse>(
              204, "No Content", ix::HttpErrorCode::Ok, respHeaders, "");
        }

        if (req->method == "GET" && req->uri == "/v1/health") {
          bool audioActive = m_audioManager ? m_audioManager->getStatus().active : false;
          nlohmann::json body = {
              {"status", "ok"},
              {"hostVersion", "0.2.0"},
              {"os", "windows-x64"},
              {"milestone", 2},
              {"formatsSupported", nlohmann::json::array({"vst3"})},
              {"audioEngineActive", m_instanceManager != nullptr},
              {"auditionActive", audioActive},
              {"wsPort", m_config.wsPort},
              {"wsUrl", "ws://127.0.0.1:" + std::to_string(m_config.wsPort) + "/ws"},
              {"requiresPairing", true},
          };
          return std::make_shared<ix::HttpResponse>(
              200, "OK", ix::HttpErrorCode::Ok, respHeaders, body.dump());
        }

        if (req->method == "POST" && req->uri == "/v1/auth/pair") {
          try {
            auto payload = nlohmann::json::parse(req->body);
            std::string code = payload.value("pairingCode", "");
            std::string tok = payload.value("pairToken", "");

            bool codeMatch = !code.empty() && SecurityPolicy::constantTimeEquals(code, m_config.pairingCode);
            bool tokMatch = !tok.empty() && SecurityPolicy::constantTimeEquals(tok, m_config.sessionToken);

            if (!codeMatch && !tokMatch) {
              return std::make_shared<ix::HttpResponse>(
                  401, "Unauthorized", ix::HttpErrorCode::Ok, respHeaders,
                  nlohmann::json({{"error", "Invalid pairing code or token"}}).dump());
            }

            m_pairedOnce = true;
            nlohmann::json body = {
                {"paired", true},
                {"sessionToken", m_config.sessionToken},
                {"wsUrl", "ws://127.0.0.1:" + std::to_string(m_config.wsPort) + "/ws"},
                {"hostVersion", "0.2.0"},
                {"os", "windows-x64"},
                {"milestone", 2},
                {"formatsSupported", nlohmann::json::array({"vst3"})},
            };
            return std::make_shared<ix::HttpResponse>(
                200, "OK", ix::HttpErrorCode::Ok, respHeaders, body.dump());
          } catch (...) {
            return std::make_shared<ix::HttpResponse>(
                400, "Bad Request", ix::HttpErrorCode::Ok, respHeaders,
                nlohmann::json({{"error", "Malformed JSON payload"}}).dump());
          }
        }

        // Graceful host shutdown is only available to a client holding the per-launch
        // session bearer token. The callback asks the owning process to unwind workers
        // and audio devices on its normal main-loop path.
        if (req->method == "POST" && req->uri == "/v1/host/shutdown") {
          if (!isBearerAuthorized(req->headers)) {
            return std::make_shared<ix::HttpResponse>(
                401, "Unauthorized", ix::HttpErrorCode::Ok, respHeaders,
                nlohmann::json({{"error", "Bearer session token required"}}).dump());
          }
          if (m_shutdownHandler) m_shutdownHandler();
          return std::make_shared<ix::HttpResponse>(
              202, "Accepted", ix::HttpErrorCode::Ok, respHeaders,
              nlohmann::json({{"stopping", true}}).dump());
        }

        // High-throughput authenticated offline stereo float32 rendering endpoint
        if (req->method == "POST" && req->uri == "/v1/audio/process-offline") {
          if (!isBearerAuthorized(req->headers)) {
            return std::make_shared<ix::HttpResponse>(
                401, "Unauthorized", ix::HttpErrorCode::Ok, respHeaders,
                nlohmann::json({{"error", "Bearer session token required"}}).dump());
          }
          if (!m_instanceManager) {
            return std::make_shared<ix::HttpResponse>(
                503, "Service Unavailable", ix::HttpErrorCode::Ok, respHeaders,
                nlohmann::json({{"error", "PluginInstanceManager not active"}}).dump());
          }
          // Bounded size guard (~96 MB raw payload cap for browser transfer safety)
          if (req->body.size() > 96u * 1024u * 1024u) {
            return std::make_shared<ix::HttpResponse>(
                413, "Payload Too Large", ix::HttpErrorCode::Ok, respHeaders,
                nlohmann::json({{"error", "Offline render payload exceeds 96MB safety limit"}}).dump());
          }

          try {
            auto payload = nlohmann::json::parse(req->body);
            std::vector<std::string> instanceIds;
            if (payload.contains("instanceIds") && payload["instanceIds"].is_array()) {
              for (const auto& idVal : payload["instanceIds"]) {
                if (idVal.is_string()) instanceIds.push_back(idVal.get<std::string>());
              }
            }
            int sampleRate = payload.value("sampleRate", 48000);
            int blockSize = payload.value("blockSize", 512);
            std::string leftB64 = payload.value("leftBase64", "");
            std::string rightB64 = payload.value("rightBase64", "");

            std::vector<float> left, right;
            if (!AudioRouter::decodeFloat32Base64(leftB64, left) ||
                !AudioRouter::decodeFloat32Base64(rightB64, right) ||
                left.empty() || left.size() != right.size()) {
              return std::make_shared<ix::HttpResponse>(
                  400, "Bad Request", ix::HttpErrorCode::Ok, respHeaders,
                  nlohmann::json({{"error", "Invalid or mismatched Base64 Float32 stereo channels"}}).dump());
            }

            auto stats = AudioRouter::processSequentialOffline(
                *m_instanceManager, instanceIds, sampleRate, blockSize, left, right, 5000);
            if (!stats.ok) {
              return std::make_shared<ix::HttpResponse>(
                  422, "Unprocessable Entity", ix::HttpErrorCode::Ok, respHeaders,
                  nlohmann::json({
                      {"error", stats.error},
                      {"failedInstanceId", stats.failedInstanceId},
                  }).dump());
            }

            nlohmann::json out = {
                {"ok", true},
                {"sampleRate", stats.sampleRate},
                {"totalFrames", stats.totalFrames},
                {"totalLatencySamples", stats.totalLatencySamples},
                {"durationMs", stats.durationMs},
                {"leftBase64", AudioRouter::encodeFloat32Base64(left)},
                {"rightBase64", AudioRouter::encodeFloat32Base64(right)},
            };
            return std::make_shared<ix::HttpResponse>(
                200, "OK", ix::HttpErrorCode::Ok, respHeaders, out.dump());
          } catch (...) {
            return std::make_shared<ix::HttpResponse>(
                400, "Bad Request", ix::HttpErrorCode::Ok, respHeaders,
                nlohmann::json({{"error", "Malformed JSON offline audio request"}}).dump());
          }
        }

        return std::make_shared<ix::HttpResponse>(
            404, "Not Found", ix::HttpErrorCode::Ok, respHeaders,
            nlohmann::json({{"error", "Endpoint not found"}}).dump());
      });

  m_impl->wsServer->setConnectionStateFactory([]() {
    return std::make_shared<ClientConnState>();
  });

  m_impl->wsServer->setOnClientMessageCallback(
      [this, getHeaderCI](
          std::shared_ptr<ix::ConnectionState> rawState,
          ix::WebSocket& ws,
          const ix::WebSocketMessagePtr& msg) {
        auto state = std::static_pointer_cast<ClientConnState>(rawState);

        if (msg->type == ix::WebSocketMessageType::Open) {
          std::string origin = getHeaderCI(msg->openInfo.headers, "origin");
          if (!origin.empty() && !m_security.isOriginAllowed(origin)) {
            ws.close(4003, "Unauthorized Origin");
            return;
          }
          state->origin = origin;
          std::lock_guard<std::mutex> lock(m_impl->wsMutex);
          m_impl->clients.insert(&ws);
          return;
        }

        if (msg->type == ix::WebSocketMessageType::Close) {
          if (state->authenticated) {
            state->authenticated = false;
            --m_authedClients;
          }
          std::lock_guard<std::mutex> lock(m_impl->wsMutex);
          m_impl->clients.erase(&ws);
          return;
        }

        if (msg->type != ix::WebSocketMessageType::Message) return;

        nlohmann::json req;
        nlohmann::json id = nullptr;
        try {
          req = nlohmann::json::parse(msg->str);
          if (req.contains("id")) id = req["id"];
        } catch (...) {
          ws.send(nlohmann::json({
              {"jsonrpc", "2.0"},
              {"id", nullptr},
              {"error", {{"code", -32700}, {"message", "Parse error"}}},
          }).dump());
          return;
        }

        std::string method = req.value("method", "");
        nlohmann::json params = req.value("params", nlohmann::json::object());

        auto sendError = [&](int code, const std::string& message) {
          ws.send(nlohmann::json({
              {"jsonrpc", "2.0"},
              {"id", id},
              {"error", {{"code", code}, {"message", message}}},
          }).dump());
        };

        auto sendResult = [&](const nlohmann::json& result) {
          ws.send(nlohmann::json({
              {"jsonrpc", "2.0"},
              {"id", id},
              {"result", result},
          }).dump());
        };

        if (!SecurityPolicy::isAllowedRpcMethod(method)) {
          sendError(-32601, "Method not allowed: " + method);
          return;
        }

        if (method == "host.auth") {
          std::string tok = params.value("sessionToken", "");
          if (SecurityPolicy::constantTimeEquals(tok, m_config.sessionToken)) {
            if (!state->authenticated) ++m_authedClients;
            state->authenticated = true;
            m_pairedOnce = true;
            sendResult({{"authenticated", true}, {"hostVersion", "0.2.0"}, {"milestone", 2}});
          } else {
            sendError(4001, "Invalid session token");
            ws.close(4001, "Invalid session token");
          }
          return;
        }

        if (!state->authenticated) {
          sendError(4001, "Unauthenticated: send host.auth first");
          return;
        }

        if (method == "host.info") {
          sendResult({
              {"hostVersion", "0.2.0"},
              {"os", "windows-x64"},
              {"milestone", 2},
              {"formatsSupported", nlohmann::json::array({"vst3"})},
              {"audioEngineActive", m_instanceManager != nullptr},
              {"standardDirectories", m_config.standardDirectories},
              {"customDirectories", m_db.listCustomDirectories()},
          });
          return;
        }

        if (method == "catalog.list") {
          auto plugins = m_db.listAllPlugins();
          nlohmann::json arr = nlohmann::json::array();
          for (const auto& p : plugins) {
            arr.push_back(nlohmann::json::parse(serializePluginJson(p)));
          }
          sendResult({{"plugins", arr}, {"count", arr.size()}});
          return;
        }

        if (method == "catalog.history") {
          auto hist = m_db.listScanHistory(25);
          nlohmann::json arr = nlohmann::json::array();
          for (const auto& h : hist) {
            arr.push_back({
                {"id", h.id},
                {"startedAt", h.startedAt},
                {"finishedAt", h.finishedAt},
                {"mode", h.mode},
                {"totalBundles", h.totalBundles},
                {"discoveredPlugins", h.discoveredPlugins},
                {"failedBundles", h.failedBundles},
                {"skippedUnchanged", h.skippedUnchanged},
                {"summary", h.summary},
            });
          }
          sendResult({{"history", arr}});
          return;
        }

        if (method == "catalog.paths.list") {
          sendResult({
              {"standardDirectories", m_config.standardDirectories},
              {"customDirectories", m_db.listCustomDirectories()},
          });
          return;
        }

        if (method == "catalog.paths.add") {
          std::string raw = params.value("path", "");
          std::string norm;
          std::string reason;
          if (!SecurityPolicy::isSafeCustomScanDirectory(raw, norm, reason)) {
            sendError(-32602, reason);
            return;
          }
          std::string err;
          if (!m_db.addCustomDirectory(norm, err)) {
            sendError(-32000, "Failed to persist custom directory: " + err);
            return;
          }
          m_security.addAllowedRoot(norm);
          sendResult({{"added", norm}, {"customDirectories", m_db.listCustomDirectories()}});
          return;
        }

        if (method == "catalog.paths.remove") {
          std::string raw = params.value("path", "");
          m_db.removeCustomDirectory(raw);
          sendResult({{"removed", raw}, {"customDirectories", m_db.listCustomDirectories()}});
          return;
        }

        if (method == "catalog.setPreference") {
          std::string uid = params.value("uid", "");
          std::string bundlePath = params.value("bundlePath", "");
          std::optional<bool> fav;
          std::optional<bool> dis;
          std::optional<int64_t> used;
          if (params.contains("favorite") && params["favorite"].is_boolean()) fav = params["favorite"].get<bool>();
          if (params.contains("disabledByUser") && params["disabledByUser"].is_boolean()) dis = params["disabledByUser"].get<bool>();
          if (params.contains("lastUsedAt") && params["lastUsedAt"].is_number_integer()) used = params["lastUsedAt"].get<int64_t>();
          bool ok = m_db.setPluginPreference(uid, bundlePath, fav, dis, used);
          sendResult({{"updated", ok}});
          return;
        }

        if (method == "catalog.retryPlugin") {
          std::string uid = params.value("uid", "");
          std::string bundlePath = params.value("bundlePath", "");
          if (!m_security.isPathWithinAllowedRoots(bundlePath)) {
            sendError(4003, "Path outside authorized scan directories");
            return;
          }
          m_db.clearQuarantineAndResetFailures(uid, bundlePath);
          if (m_scanHandler && !m_scanInProgress.exchange(true)) {
            std::thread([this, bundlePath]() {
              m_scanHandler("retry", bundlePath, [this](int done, int total, const std::string& b, const std::string& st) {
                broadcastNotification("catalog.scanProgress", nlohmann::json({
                    {"completed", done},
                    {"total", total},
                    {"currentBundle", b},
                    {"status", st},
                }).dump());
              });
              m_scanInProgress = false;
            }).detach();
          }
          sendResult({{"started", true}, {"mode", "retry"}});
          return;
        }

        if (method == "catalog.scan") {
          std::string mode = params.value("mode", "incremental");
          if (m_scanInProgress.load()) {
            sendResult({{"started", false}, {"alreadyRunning", true}});
            return;
          }
          if (!startScan(mode)) {
            sendResult({{"started", false}, {"alreadyRunning", m_scanInProgress.load()}});
            return;
          }
          if (mode != "incremental" && mode != "full" && mode != "force") mode = "incremental";
          sendResult({{"started", true}, {"mode", mode}});
          return;
        }

        // ---------------- Milestone 2 Plugin Hosting & Audio RPCs ----------------

        if (method == "plugin.listInstances") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          nlohmann::json arr = nlohmann::json::array();
          for (const auto& inst : m_instanceManager->listInstances()) {
            arr.push_back(serializeInstanceJson(inst));
          }
          sendResult({{"instances", arr}});
          return;
        }

        if (method == "plugin.load") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string uid = params.value("uid", "");
          std::string bundlePath = params.value("bundlePath", "");
          double sampleRate = params.value("sampleRate", 48000.0);
          int blockSize = params.value("blockSize", 512);
          int channels = params.value("channels", 2);
          if (!bundlePath.empty() && !m_security.isPathWithinAllowedRoots(bundlePath)) {
            sendError(4003, "Plugin bundle path outside authorized scan directories");
            return;
          }
          PluginInstanceInfo info;
          std::string err;
          if (!m_instanceManager->loadPlugin(uid, bundlePath, sampleRate, blockSize, channels, info, err)) {
            sendError(-32001, err);
            return;
          }
          sendResult(serializeInstanceJson(info));
          return;
        }

        if (method == "plugin.unload") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          std::string err;
          if (!m_instanceManager->unloadPlugin(instanceId, err)) {
            sendError(-32002, err);
            return;
          }
          sendResult({{"unloaded", true}, {"instanceId", instanceId}});
          return;
        }

        if (method == "plugin.setParameter") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          uint32_t paramId = params.value("paramId", 0u);
          double val = params.value("valueNormalized", 0.0);
          std::string disp, err;
          if (!m_instanceManager->setParameter(instanceId, paramId, val, disp, err)) {
            sendError(-32003, err);
            return;
          }
          sendResult({{"instanceId", instanceId}, {"paramId", paramId}, {"valueNormalized", val}, {"displayValue", disp}});
          return;
        }

        if (method == "plugin.getParameters") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          std::vector<ParameterValue> list;
          std::string err;
          if (!m_instanceManager->getParameters(instanceId, list, err)) {
            sendError(-32003, err);
            return;
          }
          nlohmann::json arr = nlohmann::json::array();
          for (const auto& p : list) {
            arr.push_back({
                {"id", p.id}, {"name", p.name}, {"label", p.label},
                {"valueNormalized", p.valueNormalized},
                {"defaultValueNormalized", p.defaultValueNormalized},
                {"stepCount", p.stepCount}, {"isAutomatable", p.isAutomatable},
                {"isReadOnly", p.isReadOnly}, {"isBypass", p.isBypass},
                {"displayValue", p.displayValue},
            });
          }
          sendResult({{"instanceId", instanceId}, {"parameters", arr}});
          return;
        }

        if (method == "plugin.setBypass") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          bool bypassed = params.value("bypassed", false);
          std::string err;
          if (!m_instanceManager->setBypass(instanceId, bypassed, err)) {
            sendError(-32003, err);
            return;
          }
          sendResult({{"instanceId", instanceId}, {"bypassed", bypassed}});
          return;
        }

        if (method == "plugin.getState") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          std::string stateB64, err;
          if (!m_instanceManager->getStateBase64(instanceId, stateB64, err)) {
            sendError(-32004, err);
            return;
          }
          sendResult({{"instanceId", instanceId}, {"stateBase64", stateB64}});
          return;
        }

        if (method == "plugin.setState") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          std::string stateB64 = params.value("stateBase64", "");
          std::string err;
          if (!m_instanceManager->setStateBase64(instanceId, stateB64, err)) {
            sendError(-32004, err);
            return;
          }
          sendResult({{"instanceId", instanceId}, {"restored", true}});
          return;
        }

        if (method == "plugin.openEditor") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          std::string err;
          if (!m_instanceManager->openEditor(instanceId, err)) {
            sendError(-32005, err);
            return;
          }
          sendResult({{"instanceId", instanceId}, {"editorOpen", true}});
          return;
        }

        if (method == "plugin.closeEditor") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::string instanceId = params.value("instanceId", "");
          std::string err;
          if (!m_instanceManager->closeEditor(instanceId, err)) {
            sendError(-32005, err);
            return;
          }
          sendResult({{"instanceId", instanceId}, {"editorOpen", false}});
          return;
        }

        if (method == "audio.devices") {
          nlohmann::json arr = nlohmann::json::array();
          if (m_audioManager) {
            for (const auto& d : m_audioManager->listOutputDevices()) {
              arr.push_back({
                  {"id", d.id}, {"name", d.name}, {"driverType", d.driverType},
                  {"maxOutputChannels", d.maxOutputChannels},
                  {"supportedSampleRates", d.supportedSampleRates},
                  {"defaultBufferSize", d.defaultBufferSize},
                  {"isDefault", d.isDefault},
              });
            }
          }
          sendResult({{"devices", arr}});
          return;
        }

        if (method == "audio.processOffline") {
          if (!m_instanceManager) { sendError(-32000, "PluginInstanceManager disabled"); return; }
          std::vector<std::string> instanceIds;
          if (params.contains("instanceIds") && params["instanceIds"].is_array()) {
            for (const auto& item : params["instanceIds"]) {
              if (item.is_string()) instanceIds.push_back(item.get<std::string>());
            }
          }
          int sampleRate = params.value("sampleRate", 48000);
          int blockSize = params.value("blockSize", 512);
          std::vector<float> left, right;
          if (!AudioRouter::decodeFloat32Base64(params.value("leftBase64", ""), left) ||
              !AudioRouter::decodeFloat32Base64(params.value("rightBase64", ""), right) ||
              left.empty() || left.size() != right.size()) {
            sendError(-32602, "Invalid Float32 stereo buffers");
            return;
          }
          auto stats = AudioRouter::processSequentialOffline(
              *m_instanceManager, instanceIds, sampleRate, blockSize, left, right, 5000);
          if (!stats.ok) {
            sendError(-32010, stats.error);
            return;
          }
          sendResult({
              {"ok", true},
              {"sampleRate", stats.sampleRate},
              {"totalFrames", stats.totalFrames},
              {"totalLatencySamples", stats.totalLatencySamples},
              {"durationMs", stats.durationMs},
              {"leftBase64", AudioRouter::encodeFloat32Base64(left)},
              {"rightBase64", AudioRouter::encodeFloat32Base64(right)},
          });
          return;
        }

        if (method == "audio.auditionStart") {
          if (!m_audioManager) { sendError(-32000, "WasapiDeviceManager unavailable"); return; }
          std::vector<float> left, right;
          if (!AudioRouter::decodeFloat32Base64(params.value("leftBase64", ""), left) ||
              !AudioRouter::decodeFloat32Base64(params.value("rightBase64", ""), right)) {
            sendError(-32602, "Invalid Base64 Float32 stereo audio");
            return;
          }
          double sampleRate = params.value("sampleRate", 48000.0);
          std::string devId = params.value("deviceId", "");
          bool loop = params.value("loop", true);
          std::string err;
          if (!m_audioManager->startAudition(std::move(left), std::move(right), sampleRate, devId, loop, err)) {
            sendError(-32011, err);
            return;
          }
          auto st = m_audioManager->getStatus();
          sendResult({{"active", st.active}, {"deviceName", st.deviceName}, {"driverType", st.driverType}});
          return;
        }

        if (method == "audio.auditionStop") {
          if (m_audioManager) m_audioManager->stopAudition();
          sendResult({{"active", false}});
          return;
        }

        if (method == "audio.auditionStatus") {
          if (!m_audioManager) {
            sendResult({{"active", false}});
            return;
          }
          auto st = m_audioManager->getStatus();
          sendResult({
              {"active", st.active}, {"deviceName", st.deviceName}, {"driverType", st.driverType},
              {"sampleRate", st.sampleRate}, {"bufferSize", st.bufferSize},
              {"totalFrames", st.totalFrames}, {"playedFrames", st.playedFrames},
              {"underruns", st.underruns}, {"lastError", st.lastError},
          });
          return;
        }
      });

  auto httpListen = m_impl->httpServer->listen();
  if (!httpListen.first) {
    errorOut = "HTTP server failed to bind 127.0.0.1:" + std::to_string(m_config.httpPort) + " — " + httpListen.second;
    return false;
  }

  auto wsListen = m_impl->wsServer->listen();
  if (!wsListen.first) {
    m_impl->httpServer->stop();
    errorOut = "WebSocket server failed to bind 127.0.0.1:" + std::to_string(m_config.wsPort) + " — " + wsListen.second;
    return false;
  }

  m_impl->httpServer->start();
  m_impl->wsServer->start();
  m_running = true;
  return true;
#endif
}

void LocalIpcServer::broadcastNotification(const std::string& method, const std::string& paramsJson) {
#ifdef SYN_HAS_IXWEBSOCKET
  nlohmann::json params = nlohmann::json::object();
  try {
    params = nlohmann::json::parse(paramsJson);
  } catch (...) {}
  std::string payload = nlohmann::json({
      {"jsonrpc", "2.0"},
      {"method", method},
      {"params", params},
  }).dump();

  std::lock_guard<std::mutex> lock(m_impl->wsMutex);
  for (ix::WebSocket* client : m_impl->clients) {
    if (client) client->send(payload);
  }
#else
  (void)method; (void)paramsJson;
#endif
}

void LocalIpcServer::stop() {
#ifdef SYN_HAS_IXWEBSOCKET
  if (m_running.exchange(false)) {
    if (m_impl->wsServer) m_impl->wsServer->stop();
    if (m_impl->httpServer) m_impl->httpServer->stop();
    ix::uninitNetSystem();
  }
#endif
}

void LocalIpcServer::wait() {
  while (m_running.load()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}

} // namespace syn::host
