# SPDX-License-Identifier: AGPL-3.0-only
cmake_minimum_required(VERSION 3.25)

project(SynPluginHost
  VERSION 0.2.0
  DESCRIPTION "SYN MASTER Native Plugin Host, Crash-Isolated VST3 Worker & Audio Subsystem"
  LANGUAGES C CXX
)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Windows-first defaults (portable to macOS & Linux)
option(SYN_FETCH_DEPS "Automatically fetch pinned third-party C++ dependencies via FetchContent" ON)
option(SYN_USE_JUCE "Build JUCE 8 VST3 scanner, hosting worker, WASAPI audio, and QA test VST3" ON)
option(SYN_ENABLE_CLAP "Reserved for future milestone: CLAP plugin format support (MIT)" OFF)
option(SYN_ENABLE_AU "Reserved for future milestone: Apple AudioUnit support (macOS only)" OFF)
option(SYN_ENABLE_LV2 "Reserved for future milestone: LV2 plugin format support (Linux)" OFF)
option(SYN_ENABLE_ASIO "Optional: Steinberg ASIO SDK (requires private Steinberg ASIO headers)" OFF)

if(WIN32)
  add_compile_definitions(
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
    _WIN32_WINNT=0x0A00
  )
endif()

if(MSVC)
  add_compile_options(/utf-8 /bigobj)
endif()

# The companion host pumps JUCE message events in bounded intervals while it
# services IPC and shutdown signals. JUCE 8 disables modal-loop APIs by default;
# enable the API consistently for both JUCE modules and host translation units.
if(SYN_USE_JUCE)
  add_compile_definitions(JUCE_MODAL_LOOPS_PERMITTED=1)
endif()

include(FetchContent)

if(SYN_FETCH_DEPS)
  # nlohmann/json (MIT License)
  FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
    GIT_SHALLOW TRUE
  )

  # IXWebSocket (BSD 3-Clause License) - Loopback HTTP/WebSocket server
  FetchContent_Declare(
    ixwebsocket
    GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
    GIT_TAG v11.4.5
    GIT_SHALLOW TRUE
  )
  set(USE_TLS OFF CACHE BOOL "" FORCE)
  set(USE_ZLIB OFF CACHE BOOL "" FORCE)
  set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)

  # SQLite 3 Amalgamation (Public Domain)
  FetchContent_Declare(
    sqlite3_amalgamation
    URL https://www.sqlite.org/2024/sqlite-amalgamation-3470200.zip
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  )

  FetchContent_MakeAvailable(nlohmann_json ixwebsocket sqlite3_amalgamation)

  add_library(syn_sqlite3 STATIC
    "${sqlite3_amalgamation_SOURCE_DIR}/sqlite3.c"
  )
  target_include_directories(syn_sqlite3 PUBLIC "${sqlite3_amalgamation_SOURCE_DIR}")
  if(UNIX)
    target_link_libraries(syn_sqlite3 PRIVATE dl pthread)
  endif()

  if(SYN_USE_JUCE)
    # JUCE 8 (dual licensed: AGPLv3 OR commercial JUCE licence). SYN-MASTER uses the AGPLv3
    # option, so the native companion is AGPL-3.0-only (see native/LICENSE).
    # JUCE 8.0.17-security is the latest 8.0.x security release (2026-11-02). It bundles the
    # Steinberg VST3 SDK 3.8.0, which is MIT licensed
    # (modules/juce_audio_processors_headless/format_types/VST3_SDK/LICENSE.txt).
    FetchContent_Declare(
      JUCE
      GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
      GIT_TAG 8.0.17-security
      GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(JUCE)
  endif()
endif()

# ---------------------------------------------------------------------------
# syn_host_core: PE binary inspection, SQLite catalog, security policy,
# isolated worker IPC, sequential AudioRouter, WASAPI manager, and HTTP/WS server
# ---------------------------------------------------------------------------
add_library(syn_host_core STATIC
  syn_host_core/src/WindowsPeInspector.cpp
  syn_host_core/src/SecurityPolicy.cpp
  syn_host_core/src/PluginCatalogDb.cpp
  syn_host_core/src/ProcessRunner.cpp
  syn_host_core/src/PluginInstanceManager.cpp
  syn_host_core/src/AudioRouter.cpp
  syn_host_core/src/WasapiDeviceManager.cpp
  syn_host_core/src/LocalIpcServer.cpp
)

target_include_directories(syn_host_core PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}/syn_host_core/include"
)

if(SYN_FETCH_DEPS)
  target_link_libraries(syn_host_core PUBLIC
    nlohmann_json::nlohmann_json
    ixwebsocket
    syn_sqlite3
  )
  target_compile_definitions(syn_host_core PUBLIC SYN_HAS_SQLITE=1 SYN_HAS_IXWEBSOCKET=1)
endif()

if(SYN_USE_JUCE AND TARGET juce::juce_audio_devices)
  target_link_libraries(syn_host_core PUBLIC
    juce::juce_audio_devices
    juce::juce_audio_basics
    juce::juce_core
    juce::juce_events
  )
  target_compile_definitions(syn_host_core PUBLIC
    SYN_HAS_JUCE_AUDIO_DEVICES=1
    JUCE_WASAPI=1
    $<$<BOOL:${SYN_ENABLE_ASIO}>:JUCE_ASIO=1>
  )
endif()

if(WIN32)
  target_link_libraries(syn_host_core PUBLIC ws2_32 bcrypt shell32 shlwapi advapi32 ole32 uuid)
elseif(UNIX)
  target_link_libraries(syn_host_core PUBLIC pthread)
endif()

set(SYN_STAGE_OUTPUT_DIR "${CMAKE_BINARY_DIR}/$<CONFIG>")

# ---------------------------------------------------------------------------
# syn-plugin-scanner: Crash-isolated out-of-process VST3 bundle scanner
# ---------------------------------------------------------------------------
if(SYN_USE_JUCE AND TARGET juce::juce_audio_processors)
  juce_add_console_app(syn-plugin-scanner
    PRODUCT_NAME "syn-plugin-scanner"
    COMPANY_NAME "SYN MASTER"
  )
  target_sources(syn-plugin-scanner PRIVATE syn_plugin_scanner/main.cpp)
  target_compile_definitions(syn-plugin-scanner PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=0
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
  )
  target_link_libraries(syn-plugin-scanner PRIVATE
    syn_host_core
    juce::juce_audio_processors
    juce::juce_core
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
  )
else()
  add_executable(syn-plugin-scanner syn_plugin_scanner/main.cpp)
  target_link_libraries(syn-plugin-scanner PRIVATE syn_host_core)
endif()
set_target_properties(syn-plugin-scanner PROPERTIES
  OUTPUT_NAME "syn-plugin-scanner"
  RUNTIME_OUTPUT_DIRECTORY "${SYN_STAGE_OUTPUT_DIR}"
)

# ---------------------------------------------------------------------------
# syn-plugin-worker: Isolated out-of-process VST3 hosting & GUI editor worker
# ---------------------------------------------------------------------------
if(SYN_USE_JUCE AND TARGET juce::juce_audio_processors)
  juce_add_console_app(syn-plugin-worker
    PRODUCT_NAME "syn-plugin-worker"
    COMPANY_NAME "SYN MASTER"
  )
  target_sources(syn-plugin-worker PRIVATE syn_plugin_worker/main.cpp)
  target_compile_definitions(syn-plugin-worker PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=0
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
  )
  target_link_libraries(syn-plugin-worker PRIVATE
    syn_host_core
    juce::juce_audio_processors
    juce::juce_core
    juce::juce_events
    juce::juce_gui_basics
    juce::juce_recommended_config_flags
  )
else()
  add_executable(syn-plugin-worker syn_plugin_worker/main.cpp)
  target_link_libraries(syn-plugin-worker PRIVATE syn_host_core)
endif()
set_target_properties(syn-plugin-worker PROPERTIES
  OUTPUT_NAME "syn-plugin-worker"
  RUNTIME_OUTPUT_DIRECTORY "${SYN_STAGE_OUTPUT_DIR}"
)

# ---------------------------------------------------------------------------
# syn-test-vst3-gain: Deterministic JUCE 8 Test VST3 Fixture for Windows QA
# ---------------------------------------------------------------------------
if(SYN_USE_JUCE AND TARGET juce::juce_audio_processors)
  juce_add_plugin(syn_test_vst3_gain
    COMPANY_NAME "SYN MASTER QA"
    BUNDLE_ID "com.synmaster.qa.gain"
    PLUGIN_MANUFACTURER_CODE SYMQ
    PLUGIN_CODE STGT
    FORMATS VST3
    PRODUCT_NAME "SYN Test Gain and Tilt QA"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
  )
  target_sources(syn_test_vst3_gain PRIVATE
    syn_test_vst3_gain/Source/PluginProcessor.cpp
    syn_test_vst3_gain/Source/PluginEditor.cpp
  )
  target_compile_definitions(syn_test_vst3_gain PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
  )
  target_link_libraries(syn_test_vst3_gain PRIVATE
    juce::juce_audio_utils
    juce::juce_recommended_config_flags
  )
endif()

# ---------------------------------------------------------------------------
# syn-plugin-host: Windows Companion Host Daemon (Milestone 2)
# ---------------------------------------------------------------------------
add_executable(syn-plugin-host
  syn_plugin_host/main.cpp
)
target_link_libraries(syn-plugin-host PRIVATE syn_host_core)
if(SYN_FETCH_DEPS)
  target_compile_definitions(syn-plugin-host PRIVATE SYN_HOST_FULL_BUILD=1)
endif()
set_target_properties(syn-plugin-host PROPERTIES
  OUTPUT_NAME "syn-plugin-host"
  RUNTIME_OUTPUT_DIRECTORY "${SYN_STAGE_OUTPUT_DIR}"
)

# ---------------------------------------------------------------------------
# C++20 Unit & Worker Isolation Tests
# ---------------------------------------------------------------------------
enable_testing()
add_executable(syn_core_tests
  tests/test_core.cpp
  syn_host_core/src/WindowsPeInspector.cpp
  syn_host_core/src/SecurityPolicy.cpp
  syn_host_core/src/ProcessRunner.cpp
  syn_host_core/src/AudioRouter.cpp
  syn_host_core/src/PluginInstanceManager.cpp
)
target_include_directories(syn_core_tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/syn_host_core/include"
)
if(WIN32)
  # SecurityPolicy.cpp is compiled directly into this test executable rather
  # than linked through syn_host_core, so repeat its Windows crypto dependency.
  target_link_libraries(syn_core_tests PRIVATE bcrypt)
elseif(UNIX)
  target_link_libraries(syn_core_tests PRIVATE pthread)
endif()
add_dependencies(syn_core_tests syn-plugin-worker)
target_compile_definitions(syn_core_tests PRIVATE
  SYN_TEST_WORKER_PATH="$<TARGET_FILE:syn-plugin-worker>"
)
set_target_properties(syn_core_tests PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${SYN_STAGE_OUTPUT_DIR}"
)
add_test(NAME SynCorePortableTests COMMAND syn_core_tests)
