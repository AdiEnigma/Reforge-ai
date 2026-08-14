---
name: Forge Industrial AI
colors:
  surface: '#1a120c'
  surface-dim: '#1a120c'
  surface-bright: '#413730'
  surface-container-lowest: '#140d07'
  surface-container-low: '#221a14'
  surface-container: '#271e18'
  surface-container-high: '#322821'
  surface-container-highest: '#3d332c'
  on-surface: '#f0dfd5'
  on-surface-variant: '#dac2b2'
  inverse-surface: '#f0dfd5'
  inverse-on-surface: '#382e28'
  outline: '#a28d7e'
  outline-variant: '#544337'
  surface-tint: '#ffb77f'
  primary: '#ffb77f'
  on-primary: '#4e2600'
  primary-container: '#d47a25'
  on-primary-container: '#442000'
  inverse-primary: '#914c00'
  secondary: '#a7d46e'
  on-secondary: '#1f3700'
  secondary-container: '#3a5f00'
  on-secondary-container: '#aad871'
  tertiary: '#ffb77e'
  on-tertiary: '#4d2600'
  tertiary-container: '#d47a23'
  on-tertiary-container: '#442100'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#ffdcc3'
  primary-fixed-dim: '#ffb77f'
  on-primary-fixed: '#2f1500'
  on-primary-fixed-variant: '#6f3900'
  secondary-fixed: '#c3f187'
  secondary-fixed-dim: '#a7d46e'
  on-secondary-fixed: '#102000'
  on-secondary-fixed-variant: '#304f00'
  tertiary-fixed: '#ffdcc3'
  tertiary-fixed-dim: '#ffb77e'
  on-tertiary-fixed: '#2f1500'
  on-tertiary-fixed-variant: '#6e3900'
  background: '#1a120c'
  on-background: '#f0dfd5'
  surface-variant: '#3d332c'
typography:
  display-lg:
    fontFamily: Chivo
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Chivo
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
  headline-md:
    fontFamily: Chivo
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  mono-data:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: 0.02em
  label-caps:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '700'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  grid-unit: 8px
  gutter: 1px
  margin-sm: 16px
  margin-md: 24px
  margin-lg: 40px
---

## Brand & Style

This design system is built for the professional engineering sector, specifically reverse-engineering and industrial AI synthesis. The aesthetic shifts away from typical "Silicon Valley" tech tropes toward a **Warm Industrial Foundry** aesthetic. It prioritizes the feeling of a precision engineering workbench—reliable, technical, and high-fidelity.

The design style is **Minimal Industrial**. It utilizes a sophisticated "Redwood" and "Aztec Gold" palette to evoke the heat of manufacturing and the warmth of raw materials, contrasted with sharp, high-contrast indicators for precision data. The interface should feel like a physical tool; it is structured, structured by measurement, and devoid of unnecessary decorative flourishes.

**Visual Principles:**
- **Mechanical Precision:** Use thin (1px) technical lines and grid overlays rather than soft shadows.
- **Material Warmth:** Deep earth tones serve as the foundation, creating a focused, low-strain environment for complex data analysis.
- **Functional Density:** Information is organized with the rigor of a CAD schematic, utilizing monospaced accents to highlight technical specs.

## Colors

The color strategy is "foundry-dark," using heat-inspired hues to create a high-end, professional workspace.

- **Foundry Base (#6A2B08):** The deep Redwood background provides a stable, low-glare canvas for long engineering sessions.
- **Surface Aztec (#9F4C1F):** Used for containers, sidebars, and panels to create subtle depth without relying on shadows.
- **Interactive Tenne (#B76308):** The primary color for actions, providing a clear but integrated signal for interactivity.
- **Precision Highlight (#C9F88D):** A high-contrast "Sand Dollar" lime used exclusively for data status, progress indicators, and critical CAD alerts. This color cuts through the warm palette to demand immediate attention to technical accuracy.

## Typography

The typography reinforces the engineering narrative through three distinct roles:

1.  **Headlines (Chivo):** A sharp, confident sans-serif that echoes the boldness of industrial machinery. It is used for primary navigation and panel titles.
2.  **Body (Hanken Grotesk):** A clean, contemporary grotesque that ensures high readability for project descriptions and engineering logs.
3.  **Technical Data (JetBrains Mono):** This is the "voice of the machine." It is used for all coordinate data, CAD measurements, AI-generated code, and status labels.

**Usage Note:** Technical data should always be presented in `mono-data` or `label-caps` to distinguish raw output from user interface instructions.

## Layout & Spacing

The layout is governed by a **Technical Grid System**. Instead of invisible whitespace, this system utilizes subtle 1px lines and measurement markers to define boundaries.

- **The Workbench Grid:** A fluid 12-column grid background with a subtle dot pattern at 8px intervals.
- **Viewport Frames:** The central CAD viewing area is framed with "L-bracket" corner markers and coordinate scales (X/Y/Z) along the edges.
- **Panel Logic:** Side panels (Tools and Properties) are fixed-width to ensure the central viewport remains the focus.
- **Guttering:** Use 1px solid borders in a slightly lighter shade than the background to separate UI sections, simulating the seams of high-precision assembly.

## Elevation & Depth

This design system rejects traditional shadows and glassmorphism. Depth is communicated through **Tonal Layering** and **Technical Outlines**.

- **Stacked Tiers:** The background (#6A2B08) is the lowest level. Active work surfaces (#9F4C1F) sit "on top" but appear to be milled into the surface rather than floating above it.
- **Zero-Shadow Policy:** Use 1px borders in Tenne (#B76308) or Golden Bear (#DE822B) to indicate focus or activity. 
- **The "CAD Glow":** For high-priority elements, use a very tight, 2px outer glow in Sand Dollar (#C9F88D) to simulate a backlit instrumentation panel.

## Shapes

The shape language is **Precision-Milled**. 

- **Primary Radius:** Use a "Soft" 4px (0.25rem) radius for most UI components (cards, inputs) to avoid the aggression of pure sharp corners while maintaining a professional, non-consumer feel.
- **Sharp Technicals:** Viewports, data tables, and terminal windows should have 0px sharp corners to reinforce the engineering schematic aesthetic.
- **Chamfered Accents:** Where possible, use 45-degree angled cuts on corner treatments for "Primary Action" buttons to mimic industrial casing.

## Components

- **Technical Buttons:** Buttons feature 1px solid borders. Primary buttons use #B76308 background with white text; secondary buttons are transparent with #B76308 borders. All buttons use 4px corner radii.
- **Data Cards:** Surfaces use #9F4C1F. Cards are framed with a 1px border. Headers within cards should use the monospaced font and include a small "ID" or "Ref" number in the corner.
- **Engineering Chat:** A dedicated vertical panel for AI interaction. Input fields are styled like command-line prompts (`>_`). Messages from the AI appear in JetBrains Mono.
- **Progress Indicators:** Linear progress bars use the Redwood background as a track, with the Sand Dollar (#C9F88D) as the fill color to represent "Active Processing."
- **CAD Viewport:** A dark, high-contrast area with crosshair cursors and thin white or Sand Dollar wireframes.
- **Inputs:** Fields are dark-recessed with #DE822B (Golden Bear) active states. Use monospaced font for all numerical inputs.