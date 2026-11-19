#pragma once

#include "PluginProcessor.hpp"

class SynTestVst3AudioProcessorEditor : public juce::AudioProcessorEditor {
public:
  explicit SynTestVst3AudioProcessorEditor(SynTestVst3AudioProcessor&);
  ~SynTestVst3AudioProcessorEditor() override = default;

  void paint(juce::Graphics&) override;
  void resized() override;

private:
  SynTestVst3AudioProcessor& m_processor;
  juce::Slider m_gainSlider;
  juce::Slider m_tiltSlider;
  juce::Slider m_widthSlider;
  juce::Label m_gainLabel;
  juce::Label m_tiltLabel;
  juce::Label m_widthLabel;

  std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> m_gainAtt;
  std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> m_tiltAtt;
  std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> m_widthAtt;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SynTestVst3AudioProcessorEditor)
};
