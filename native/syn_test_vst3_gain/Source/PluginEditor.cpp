// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 LIL SYNN / SYN-MASTER. Part of the SYN-MASTER VST companion (native/).
#include "PluginEditor.hpp"

SynTestVst3AudioProcessorEditor::SynTestVst3AudioProcessorEditor(SynTestVst3AudioProcessor& p)
    : AudioProcessorEditor(&p), m_processor(p) {
  auto configure = [&](juce::Slider& s, juce::Label& l, const juce::String& name) {
    s.setSliderStyle(juce::Slider::RotaryVerticalDrag);
    s.setTextBoxStyle(juce::Slider::TextBoxBelow, false, 72, 18);
    s.setColour(juce::Slider::rotarySliderFillColourId, juce::Colour(0xffd4af37));
    s.setColour(juce::Slider::thumbColourId, juce::Colour(0xfff2ca52));
    addAndMakeVisible(s);

    l.setText(name, juce::dontSendNotification);
    l.setJustificationType(juce::Justification::centred);
    l.setColour(juce::Label::textColourId, juce::Colour(0xfff7f8fa));
    addAndMakeVisible(l);
  };

  configure(m_gainSlider, m_gainLabel, "GAIN");
  configure(m_tiltSlider, m_tiltLabel, "TILT");
  configure(m_widthSlider, m_widthLabel, "WIDTH");

  m_gainAtt = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(m_processor.apvts, "gain", m_gainSlider);
  m_tiltAtt = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(m_processor.apvts, "tilt", m_tiltSlider);
  m_widthAtt = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment>(m_processor.apvts, "width", m_widthSlider);

  setSize(380, 210);
}

void SynTestVst3AudioProcessorEditor::paint(juce::Graphics& g) {
  g.fillAll(juce::Colour(0xff0b0c10));
  g.setColour(juce::Colour(0xffd4af37));
  g.drawRect(getLocalBounds().reduced(6), 1);

  g.setFont(juce::FontOptions(14.0f, juce::Font::bold));
  g.drawText("SYN TEST GAIN & TILT  ·  QA VST3 FIXTURE", 16, 12, getWidth() - 32, 22, juce::Justification::centredLeft);
}

void SynTestVst3AudioProcessorEditor::resized() {
  auto area = getLocalBounds().reduced(16);
  area.removeFromTop(28);
  int colW = area.getWidth() / 3;
  for (int i = 0; i < 3; ++i) {
    auto col = area.removeFromLeft(colW);
    auto lbl = col.removeFromTop(20);
    if (i == 0) { m_gainLabel.setBounds(lbl); m_gainSlider.setBounds(col); }
    else if (i == 1) { m_tiltLabel.setBounds(lbl); m_tiltSlider.setBounds(col); }
    else { m_widthLabel.setBounds(lbl); m_widthSlider.setBounds(col); }
  }
}
