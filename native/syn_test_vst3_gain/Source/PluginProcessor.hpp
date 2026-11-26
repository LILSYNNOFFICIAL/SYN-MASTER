// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

/**
 * SYN Test Gain & Tilt (QA Fixture)
 * Explicit test VST3 plugin built with JUCE 8 to provide an authentic, deterministic
 * third-party `.vst3` binary for automated and manual QA when commercial VST3 plugins
 * are not installed on a Windows test machine.
 */
class SynTestVst3AudioProcessor : public juce::AudioProcessor {
public:
  SynTestVst3AudioProcessor();
  ~SynTestVst3AudioProcessor() override = default;

  void prepareToPlay(double sampleRate, int samplesPerBlock) override;
  void releaseResources() override;
  bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
  void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

  juce::AudioProcessorEditor* createEditor() override;
  bool hasEditor() const override { return true; }

  const juce::String getName() const override { return "SYN Test Gain & Tilt (QA Fixture)"; }
  bool acceptsMidi() const override { return false; }
  bool producesMidi() const override { return false; }
  bool isMidiEffect() const override { return false; }
  double getTailLengthSeconds() const override { return 0.0; }

  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return "Default"; }
  void changeProgramName(int, const juce::String&) override {}

  void getStateInformation(juce::MemoryBlock& destData) override;
  void setStateInformation(const void* data, int sizeInBytes) override;

  juce::AudioProcessorValueTreeState apvts;

private:
  double m_lpL = 0.0;
  double m_lpR = 0.0;
  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SynTestVst3AudioProcessor)
};
