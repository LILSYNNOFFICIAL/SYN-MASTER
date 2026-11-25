// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#include "PluginProcessor.hpp"
#include "PluginEditor.hpp"

#include <cmath>

namespace {
juce::AudioProcessorValueTreeState::ParameterLayout createLayout() {
  std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
  params.push_back(std::make_unique<juce::AudioParameterFloat>(
      juce::ParameterID{"gain", 1}, "Gain",
      juce::NormalisableRange<float>(-24.0f, 24.0f, 0.1f), 0.0f,
      juce::AudioParameterFloatAttributes().withLabel("dB")));
  params.push_back(std::make_unique<juce::AudioParameterFloat>(
      juce::ParameterID{"tilt", 1}, "High Tilt",
      juce::NormalisableRange<float>(-6.0f, 6.0f, 0.1f), 0.0f,
      juce::AudioParameterFloatAttributes().withLabel("dB")));
  params.push_back(std::make_unique<juce::AudioParameterFloat>(
      juce::ParameterID{"width", 1}, "Stereo Width",
      juce::NormalisableRange<float>(0.0f, 200.0f, 1.0f), 100.0f,
      juce::AudioParameterFloatAttributes().withLabel("%")));
  params.push_back(std::make_unique<juce::AudioParameterBool>(
      juce::ParameterID{"bypass", 1}, "Bypass", false));
  return {params.begin(), params.end()};
}
} // namespace

SynTestVst3AudioProcessor::SynTestVst3AudioProcessor()
    : AudioProcessor(BusesProperties()
                         .withInput("Input", juce::AudioChannelSet::stereo(), true)
                         .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      apvts(*this, nullptr, "SynTestGainState", createLayout()) {}

void SynTestVst3AudioProcessor::prepareToPlay(double, int) {
  m_lpL = 0.0;
  m_lpR = 0.0;
}

void SynTestVst3AudioProcessor::releaseResources() {}

bool SynTestVst3AudioProcessor::isBusesLayoutSupported(const BusesLayout& layouts) const {
  if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::mono() &&
      layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) {
    return false;
  }
  return layouts.getMainOutputChannelSet() == layouts.getMainInputChannelSet();
}

void SynTestVst3AudioProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) {
  juce::ScopedNoDenormals noDenormals;
  if (apvts.getRawParameterValue("bypass")->load() > 0.5f) return;

  const float gainDb = apvts.getRawParameterValue("gain")->load();
  const float tiltDb = apvts.getRawParameterValue("tilt")->load();
  const float widthPct = apvts.getRawParameterValue("width")->load() * 0.01f;

  const float linGain = std::pow(10.0f, gainDb / 20.0f);
  const float tiltAmt = (std::pow(10.0f, tiltDb / 20.0f) - 1.0f);

  const int numSamples = buffer.getNumSamples();
  const int numCh = buffer.getNumChannels();
  if (numCh == 0 || numSamples == 0) return;

  auto* l = buffer.getWritePointer(0);
  auto* r = numCh > 1 ? buffer.getWritePointer(1) : nullptr;

  for (int i = 0; i < numSamples; ++i) {
    m_lpL = 0.85 * m_lpL + 0.15 * static_cast<double>(l[i]);
    double sl = (static_cast<double>(l[i]) + tiltAmt * (static_cast<double>(l[i]) - m_lpL)) * linGain;
    if (r) {
      m_lpR = 0.85 * m_lpR + 0.15 * static_cast<double>(r[i]);
      double sr = (static_cast<double>(r[i]) + tiltAmt * (static_cast<double>(r[i]) - m_lpR)) * linGain;
      double mid = 0.5 * (sl + sr);
      double side = 0.5 * (sl - sr) * widthPct;
      l[i] = static_cast<float>(mid + side);
      r[i] = static_cast<float>(mid - side);
    } else {
      l[i] = static_cast<float>(sl);
    }
  }
}

juce::AudioProcessorEditor* SynTestVst3AudioProcessor::createEditor() {
  return new SynTestVst3AudioProcessorEditor(*this);
}

void SynTestVst3AudioProcessor::getStateInformation(juce::MemoryBlock& destData) {
  auto state = apvts.copyState();
  if (auto xml = state.createXml()) {
    copyXmlToBinary(*xml, destData);
  }
}

void SynTestVst3AudioProcessor::setStateInformation(const void* data, int sizeInBytes) {
  if (auto xmlState = getXmlFromBinary(data, sizeInBytes)) {
    if (xmlState->hasTagName(apvts.state.getType())) {
      apvts.replaceState(juce::ValueTree::fromXml(*xmlState));
    }
  }
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
  return new SynTestVst3AudioProcessor();
}
