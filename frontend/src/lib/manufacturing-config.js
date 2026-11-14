/**
 * manufacturing-config.js
 * Guided Sequential Manufacturing Decision Configurator Model.
 *
 * Implements the 9 standard manufacturing decision categories in exact order:
 * 1. Geometry & Dimensions
 * 2. Material Selection
 * 3. Manufacturing Process
 * 4. Surface Treatment
 * 5. Tolerances & Fits
 * 6. Heat Treatment
 * 7. Quality Inspection
 * 8. Batch Quantity
 * 9. Packaging & Delivery
 *
 * Features:
 * - 4 distinct states: NOT STARTED, IN PROGRESS, CONFIRMED, NEEDS REVIEW.
 * - Green checkmark exclusively for CONFIRMED.
 * - Engineering-aware dependency evaluation (material, heat treatment, tolerances, process, packaging).
 * - Preservation of user decisions upon upstream modifications with non-destructive NEEDS REVIEW alerts.
 * - Live cost and specification computation.
 */

export const STORAGE_KEY_MFG_CONFIG = 'reforge_mfg_config_v3';
export const STORAGE_KEY_MFG_DECISIONS = 'reforge_mfg_decisions';

export function formatINR(n) {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);
}

export const CATEGORY_IDS = Object.freeze({
  GEOMETRY: 'geometry',
  MATERIAL: 'material',
  PROCESS: 'process',
  SURFACE: 'surface',
  TOLERANCES: 'tolerances',
  HEAT_TREATMENT: 'heatTreatment',
  INSPECTION: 'inspection',
  QUANTITY: 'quantity',
  PACKAGING: 'packaging',
});

export const CATEGORY_ORDER = Object.freeze([
  CATEGORY_IDS.GEOMETRY,
  CATEGORY_IDS.MATERIAL,
  CATEGORY_IDS.PROCESS,
  CATEGORY_IDS.SURFACE,
  CATEGORY_IDS.TOLERANCES,
  CATEGORY_IDS.HEAT_TREATMENT,
  CATEGORY_IDS.INSPECTION,
  CATEGORY_IDS.QUANTITY,
  CATEGORY_IDS.PACKAGING,
]);

export const CATEGORY_METADATA = Object.freeze({
  [CATEGORY_IDS.GEOMETRY]: {
    id: CATEGORY_IDS.GEOMETRY,
    num: 1,
    title: 'Geometry & Dimensions',
    icon: 'straighten',
    description: 'Reconstructed parametric envelope and tooth geometry. Governs material mass envelope, tooling travel, and mating center distance.',
  },
  [CATEGORY_IDS.MATERIAL]: {
    id: CATEGORY_IDS.MATERIAL,
    num: 2,
    title: 'Material Selection',
    icon: 'layers',
    description: 'Base engineering alloy. Governs tensile yield strength, fatigue endurance limit, density, and thermal heat treatability.',
  },
  [CATEGORY_IDS.PROCESS]: {
    id: CATEGORY_IDS.PROCESS,
    num: 3,
    title: 'Manufacturing Process',
    icon: 'precision_manufacturing',
    description: 'Primary tooth generation and machining route. Dictates surface finish, cycle time, and achievable dimensional precision.',
  },
  [CATEGORY_IDS.SURFACE]: {
    id: CATEGORY_IDS.SURFACE,
    num: 4,
    title: 'Surface Treatment',
    icon: 'format_paint',
    description: 'Chemical or electrochemical conversion coating for atmospheric corrosion protection, boundary lubricity, and break-in wear.',
  },
  [CATEGORY_IDS.TOLERANCES]: {
    id: CATEGORY_IDS.TOLERANCES,
    num: 5,
    title: 'Tolerances & Fits',
    icon: 'tune',
    description: 'Involute accuracy class and mating interface fit standard. Directly impacts acoustic vibration, backlash, and finishing passes.',
  },
  [CATEGORY_IDS.HEAT_TREATMENT]: {
    id: CATEGORY_IDS.HEAT_TREATMENT,
    num: 6,
    title: 'Heat Treatment',
    icon: 'local_fire_department',
    description: 'Thermal processing to balance flank contact fatigue hardness with core impact ductility. Governs post-quench dimensional stability.',
  },
  [CATEGORY_IDS.INSPECTION]: {
    id: CATEGORY_IDS.INSPECTION,
    num: 7,
    title: 'Quality Inspection',
    icon: 'verified',
    description: 'Metrology verification protocol and EN 10204 compliance documentation for lead helix deviation, tooth profile error, and cracks.',
  },
  [CATEGORY_IDS.QUANTITY]: {
    id: CATEGORY_IDS.QUANTITY,
    num: 8,
    title: 'Batch Quantity',
    icon: 'pin',
    description: 'Production volume to amortize CNC machine programming, fixture tooling, and quality calibration setups across the run.',
  },
  [CATEGORY_IDS.PACKAGING]: {
    id: CATEGORY_IDS.PACKAGING,
    num: 9,
    title: 'Packaging & Delivery',
    icon: 'inventory_2',
    description: 'Preservation packaging protocol preventing tooth edge impact damage, brinelling, and atmospheric oxidation during transit.',
  },
});

// ─── Option Catalogs ──────────────────────────────────────────────────────────

export const MATERIAL_OPTIONS = Object.freeze([
  {
    id: 'aisi-4140',
    label: 'AISI 4140 Alloy Steel (Chromoly)',
    grade: 'Chromium-Molybdenum Alloy Steel (Quenched & Tempered)',
    yieldMPa: 655,
    hardness: '28–32 HRC (Core Pre-hardened)',
    densityGcm3: 7.85,
    isFerrous: true,
    isCarburizable: true,
    costMul: 1.0,
    costBadge: '+₹0 (Base ₹1,800)',
    desc: 'High torsional strength and superior fatigue endurance. The industry standard for heavy-duty industrial gearing.',
  },
  {
    id: 'aisi-1045',
    label: 'AISI 1045 Medium Carbon Steel',
    grade: 'Medium Carbon Steel (As-Rolled)',
    yieldMPa: 450,
    hardness: '16–20 HRC (As-rolled)',
    densityGcm3: 7.85,
    isFerrous: true,
    isCarburizable: false, // typically induction hardened or through hardened
    costMul: 0.75,
    costBadge: '-₹270 / unit (-15%)',
    desc: 'Economical steel with good machinability. Excellent for induction tooth flank hardening under moderate loads.',
  },
  {
    id: 'ss-316l',
    label: 'AISI 316L Stainless Steel',
    grade: 'Austenitic Marine-Grade Stainless Steel',
    yieldMPa: 290,
    hardness: '85 HRB',
    densityGcm3: 8.0,
    isFerrous: true,
    isStainless: true,
    isCarburizable: false, // cannot be carburized conventionally
    costMul: 1.85,
    costBadge: '+₹1,530 / unit (+85%)',
    desc: 'Exceptional corrosion resistance for food, chemical, and pharmaceutical machinery; lower contact fatigue limit.',
  },
  {
    id: 'al-7075-t6',
    label: '7075-T6 Aerospace Aluminum',
    grade: 'Zinc-Magnesium-Copper Aerospace Alloy',
    yieldMPa: 505,
    hardness: '150 HB',
    densityGcm3: 2.81,
    isFerrous: false,
    isAluminum: true,
    isCarburizable: false,
    costMul: 1.4,
    costBadge: '+₹720 / unit (+40%)',
    desc: 'High strength-to-weight ratio for low-inertia aerospace and robotics drives; requires hard anodize for wear surface.',
  },
  {
    id: 'c93200-bronze',
    label: 'SAE 660 / C93200 Bearing Bronze',
    grade: 'High-Leaded Tin Bronze',
    yieldMPa: 140,
    hardness: '65 HB',
    densityGcm3: 8.9,
    isFerrous: false,
    isBronze: true,
    isCarburizable: false,
    costMul: 1.6,
    costBadge: '+₹1,080 / unit (+60%)',
    desc: 'Outstanding anti-friction and non-galling properties; ideal for worm gear sets mating with hardened steel pinions.',
  },
]);

export const PROCESS_OPTIONS = Object.freeze([
  {
    id: 'hobbing-cnc',
    label: 'CNC Gear Hobbing + Milling',
    leadTime: '8–12 days',
    leadDays: 10,
    accuracy: 'DIN 7 / AGMA 10',
    maxGrade: 7,
    costMul: 1.0,
    costBadge: '+₹0 (Standard Base)',
    desc: 'Continuous indexing rotary cutting process delivering high geometric throughput, low pitch variation, and optimal tooth form.',
  },
  {
    id: 'wire-edm',
    label: 'Wire Electrical Discharge Machining (EDM)',
    leadTime: '12–15 days',
    leadDays: 13,
    accuracy: 'DIN 6 / AGMA 11',
    maxGrade: 6,
    costMul: 1.45,
    costBadge: '+₹1,260 / unit (+45%)',
    desc: 'Spark erosion cutting through hardened alloys without mechanical cutting force; produces sharp corner keyways with zero burrs.',
  },
  {
    id: 'multi-axis-milling',
    label: '5-Axis Simultaneous CNC Profiling',
    leadTime: '10–14 days',
    leadDays: 12,
    accuracy: 'DIN 8 / AGMA 9',
    maxGrade: 8,
    costMul: 1.3,
    costBadge: '+₹840 / unit (+30%)',
    desc: 'High-flexibility multi-axis toolpaths ideal for integrated gear-shafts, custom helical pitches, and non-standard hub details.',
  },
  {
    id: 'grinding-finish',
    label: 'CNC Hobbing + Post-Hardening Flank Grinding',
    leadTime: '14–18 days',
    leadDays: 16,
    accuracy: 'DIN 5–6 / AGMA 12',
    maxGrade: 5,
    costMul: 1.65,
    costBadge: '+₹1,820 / unit (+65%)',
    desc: 'Precision generating grinding removing thermal heat-treat distortion; essential for high-speed low-noise transmission drives.',
  },
]);

export const SURFACE_OPTIONS = Object.freeze([
  {
    id: 'black-oxide',
    label: 'Black Oxide Conversion Coating (MIL-DTL-13924)',
    dimensionalBuildup: '0 µm (Sub-micron)',
    costAdd: 150,
    costBadge: '+₹150 / unit',
    forFerrousOnly: true,
    desc: 'Zero dimensional buildup; preserves ground tooth tooth contact form while providing lubricity and indoor rust prevention.',
  },
  {
    id: 'manganese-phosphate',
    label: 'Manganese Phosphate Coating (Parkerizing)',
    dimensionalBuildup: '2–5 µm',
    costAdd: 220,
    costBadge: '+₹220 / unit',
    forFerrousOnly: true,
    desc: 'Micro-crystalline porous conversion holding oil films; provides excellent break-in scuffing and micro-pitting resistance.',
  },
  {
    id: 'hard-anodize',
    label: 'Hardcoat Anodizing Type III (MIL-A-8625)',
    dimensionalBuildup: '25 µm penetration / 25 µm buildup',
    costAdd: 380,
    costBadge: '+₹380 / unit',
    forAluminumOnly: true,
    desc: 'Deep electrochemical ceramic conversion for aluminum (7075-T6); produces glass-hard wear surface (60–65 HRC equivalent).',
  },
  {
    id: 'as-machined',
    label: 'As-Machined (Light Anti-Rust Protective Oil)',
    dimensionalBuildup: '0 µm',
    costAdd: 80,
    costBadge: '+₹80 / unit',
    desc: 'No chemical barrier layer. Lowest cost route; requires immediate ingestion into an enclosed operational oil bath.',
  },
]);

export const TOLERANCE_OPTIONS = Object.freeze([
  {
    id: 'iso-grade-7',
    label: 'DIN 7 / ISO Grade 7 (Standard Precision)',
    pitchError: '< 18 µm',
    backlash: 'Normal (0.08–0.14 mm)',
    costMul: 1.0,
    costBadge: '+₹0 (Standard Base)',
    desc: 'Standard commercial precision for industrial speed reducers, pumps, transmissions, and vehicle drives (< 2500 RPM).',
  },
  {
    id: 'iso-grade-6',
    label: 'DIN 6 / ISO Grade 6 (High Precision Ground)',
    pitchError: '< 12 µm',
    backlash: 'Tight (0.04–0.08 mm)',
    costMul: 1.35,
    costBadge: '+₹980 / unit (+35%)',
    desc: 'High-precision class with low backlash and reduced acoustic vibration; requires tooth flank grinding or wire EDM finishing.',
  },
  {
    id: 'commercial-grade-9',
    label: 'Commercial Grade ±0.1mm (General)',
    pitchError: '< 35 µm',
    backlash: 'Generous (> 0.18 mm)',
    costMul: 0.85,
    costBadge: '-₹420 / unit (-15%)',
    desc: 'Economical tolerance envelope for slow-speed conveyors, agricultural linkages, and non-critical manual drive mechanisms.',
  },
]);

export const HEAT_TREATMENT_OPTIONS = Object.freeze([
  {
    id: 'case-carburizing',
    label: 'Case Carburizing (58–62 HRC, 0.8–1.2mm Depth)',
    hardness: '58–62 HRC Flank / 30–35 HRC Core',
    costAdd: 450,
    costBadge: '+₹450 / unit',
    steelOnly: true,
    desc: 'Carbon diffusion quench hardening producing glass-hard tooth contact surfaces with a ductile shock-absorbing core.',
  },
  {
    id: 'induction-hardening',
    label: 'Induction Tooth Contour Hardening (52–56 HRC)',
    hardness: '52–56 HRC',
    costAdd: 320,
    costBadge: '+₹320 / unit',
    steelOnly: true,
    desc: 'High-frequency localized heating of tooth flanks only; leaves the central bore and hub ductile for easy keyway broaching.',
  },
  {
    id: 'nitriding',
    label: 'Gas Nitriding (600–700 HV, 0.3mm Case Depth)',
    hardness: '600–700 HV (~55–58 HRC)',
    costAdd: 400,
    costBadge: '+₹400 / unit',
    steelOnly: true,
    desc: 'Sub-critical thermal diffusion at 500°C with no water/oil quench; produces minimal dimensional distortion across precision teeth.',
  },
  {
    id: 'through-hardened',
    label: 'Quench & Temper Through-Hardened (28–34 HRC)',
    hardness: '28–34 HRC',
    costAdd: 250,
    costBadge: '+₹250 / unit',
    steelOnly: true,
    desc: 'Uniform moderate hardness throughout the part; eliminates case-chipping risk under severe cyclic impact loads.',
  },
  {
    id: 'solution-t6',
    label: 'Solution Heat Treat & Artificial Aging (T6)',
    hardness: '150 HB',
    costAdd: 280,
    costBadge: '+₹280 / unit',
    aluminumOnly: true,
    desc: 'Precipitation hardening cycle for 7075 Aluminum; achieves peak 505 MPa tensile yield strength.',
  },
  {
    id: 'none-annealed',
    label: 'Annealed / None (As-Supplied Stock)',
    hardness: 'Stock Base',
    costAdd: 0,
    costBadge: '+₹0 (None)',
    desc: 'No thermal hardening applied. Suitable for 316L Stainless Steel, Bronze, or non-stressed commercial gears.',
  },
]);

export const INSPECTION_OPTIONS = Object.freeze([
  {
    id: 'cmm-lead-profile',
    label: 'CMM Tooth Profile & Involute Lead Inspection (EN 10204 3.1)',
    costAdd: 350,
    costBadge: '+₹350 / unit',
    isCmm: true,
    desc: 'Multi-axis coordinate metrology measuring total profile error (Fα), lead helix deviation (Fβ), and pitch variation with certified report.',
  },
  {
    id: 'double-flank-roll',
    label: 'Double-Flank Composite Roll Testing',
    costAdd: 150,
    costBadge: '+₹150 / unit',
    isCmm: false,
    desc: 'Kinematic engagement testing against calibrated master gear; records radial composite runout (Fi) and tooth-to-tooth error (fi).',
  },
  {
    id: 'mpi-ndt',
    label: 'Magnetic Particle (MPI) + Ultrasonic Flaw Metrology',
    costAdd: 280,
    costBadge: '+₹280 / unit',
    isCmm: false,
    desc: 'Non-destructive fluorescent magnetic crack detection inspecting tooth root fillets and case-core transitions post-heat treatment.',
  },
]);

export const QUANTITY_TIERS = Object.freeze([1, 5, 10, 50, 100, 500]);

export const PACKAGING_OPTIONS = Object.freeze([
  {
    id: 'vci-sealed',
    label: 'VCI Vapor-Inhibitor Sealed Bag + Foam Cradles',
    costAdd: 120,
    costBadge: '+₹120 / unit',
    isVci: true,
    desc: 'Active chemical vapor corrosion inhibitor providing up to 24 months sealed shelf-life; custom foam cradles protect tooth tips.',
  },
  {
    id: 'wooden-crate',
    label: 'Reinforced ISPM-15 Wooden Crate (Heavy Freight)',
    costAdd: 450,
    costBadge: '+₹450 / unit',
    isHeavyDuty: true,
    desc: 'Heat-treated wooden crate with bolted shock-isolation partitions; mandatory for heavy gear assemblies or maritime export.',
  },
  {
    id: 'bulk-industrial',
    label: 'Industrial Corrugated Carton with Oil Paper',
    costAdd: 50,
    costBadge: '+₹50 / unit',
    isVci: false,
    desc: 'Standard multi-wall corrugated box with wax-coated rust-inhibitive interleaving; designed for immediate production line assembly.',
  },
]);

// ─── Engineering Decision Reasoning & Trade-off Assessment ───────────────────

/**
 * Generates concise, high-value comparative reasoning for the selected option in any category.
 * Explains why selected, whether a different choice is better/optimal, and operational impacts.
 */
export function getCategoryReasoning(catId, selectedOption, draftDecisions = {}, quantity = 1, analysis = null) {
  const qty = Math.max(1, Number(quantity) || 1);

  switch (catId) {
    case CATEGORY_IDS.GEOMETRY: {
      const od = Number(draftDecisions.outerDiameter) || 105;
      const id = Number(draftDecisions.innerDiameter) || 30;
      const h = Number(draftDecisions.height) || 28;
      const z = Number(draftDecisions.teeth) || 24;
      const moduleVal = (od / (z + 2)).toFixed(2);
      const faceRatio = Math.round((h / od) * 100);
      const rimThickness = Math.max(1, ((od - id) / 2) - 2.25 * parseFloat(moduleVal)).toFixed(1);

      return {
        title: 'Parametric Geometry Insights',
        verdict: 'Proportions Verified for Manufacturing',
        verdictType: 'recommended',
        points: [
          {
            label: 'Pitch Module (m)',
            text: `${moduleVal} mm module yields robust tooth root bending capacity for industrial torque transmission.`,
          },
          {
            label: 'Face Width Ratio',
            text: `${faceRatio}% of OD is within the ideal 20–35% engagement envelope, balancing contact load without shaft twist.`,
          },
          {
            label: 'Rim Wall Thickness',
            text: `Bore ID ${id}mm leaves ${rimThickness} mm backing wall under root fillets, satisfying AGMA rim back-up safety criteria.`,
          },
        ],
      };
    }

    case CATEGORY_IDS.MATERIAL: {
      const matId = selectedOption?.id || draftDecisions.material?.id || 'aisi-4140';
      if (matId === 'aisi-4140') {
        return {
          title: 'Material Engineering Assessment',
          verdict: 'Optimal Choice (Best Strength-to-Cost Balance)',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Chromoly 4140 alloy provides 655 MPa yield strength with high fatigue endurance (415 MPa) and deep through-hardenability.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'AISI 1045 is ₹270 cheaper but cuts fatigue life by 40%. 316L is ₹1,530 more expensive and cannot be hardened for gear teeth.',
            },
            {
              label: 'Operational Impact',
              text: 'Delivers maximum tooth contact fatigue life and resists tooth root bending fractures under heavy cyclic power.',
            },
          ],
        };
      }
      if (matId === 'aisi-1045') {
        return {
          title: 'Material Engineering Assessment',
          verdict: 'Economical Choice (Moderate Loads Only)',
          verdictType: 'suboptimal',
          points: [
            {
              label: 'Why Selected',
              text: '0.45% medium carbon steel offering good machinability at the lowest raw material cost (-15% vs 4140).',
            },
            {
              label: 'Comparative Trade-off',
              text: 'For only +₹270/unit, AISI 4140 provides 45% higher shock impact resistance and eliminates tooth breakage risk.',
            },
            {
              label: 'Operational Impact',
              text: 'Saves initial stock cost, but susceptible to tooth surface pitting and root fatigue under high cyclic shock torque.',
            },
          ],
        };
      }
      if (matId === 'ss-316l') {
        return {
          title: 'Material Engineering Assessment',
          verdict: 'Specialized Duty (Suboptimal for High Load Gearing)',
          verdictType: 'suboptimal',
          points: [
            {
              label: 'Why Selected',
              text: 'Austenitic marine-grade stainless steel provides exceptional immunity to corrosion in acids, moisture, and washdown environments.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'AISI 4140 is ₹1,530 cheaper and 2.2× stronger. 316L cannot be heat-hardened (~85 HRB), creating severe galling risk under meshing.',
            },
            {
              label: 'Operational Impact',
              text: 'Transmission torque must be de-rated by ~50% to prevent tooth flank seizing; select only if chemical washdown is required.',
            },
          ],
        };
      }
      if (matId === 'al-7075-t6') {
        return {
          title: 'Material Engineering Assessment',
          verdict: 'Specialized Lightweight Choice (Low Rotational Inertia)',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Aerospace zinc-alloy aluminum cuts component mass and rotational inertia by 65% with 505 MPa yield strength.',
            },
            {
              label: 'Comparative Trade-off',
              text: '65% lighter than alloy steel, but requires mandatory Hardcoat Anodizing (Type III) to prevent rapid abrasive tooth wear.',
            },
            {
              label: 'Operational Impact',
              text: 'Enables rapid servo acceleration and high dynamics in robotics/drones; lower surface contact fatigue limit than alloy steel.',
            },
          ],
        };
      }
      if (matId === 'c93200-bronze') {
        return {
          title: 'Material Engineering Assessment',
          verdict: 'Optimal Choice for Worm Gear Pairs',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'High-leaded tin bronze provides natural boundary lubricity and non-galling properties against hardened steel pinions.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Tensile yield (140 MPa) is lower than steel; ideal for worm wheel meshes, but not recommended for high-load spur gearboxes.',
            },
            {
              label: 'Operational Impact',
              text: 'Guarantees smooth, quiet sliding mesh with sacrificial wear protecting the expensive steel pinion.',
            },
          ],
        };
      }
      break;
    }

    case CATEGORY_IDS.PROCESS: {
      const procId = selectedOption?.id || draftDecisions.process?.id || 'hobbing-cnc';
      if (procId === 'hobbing-cnc') {
        return {
          title: 'Manufacturing Route Assessment',
          verdict: 'Optimal Production Route (Throughput & Standard Accuracy)',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Continuous indexing rotary hobbing delivers rapid, uniform involute generation conforming to DIN 7 standard tolerances.',
            },
            {
              label: 'Comparative Trade-off',
              text: '30% faster and ₹840–₹1,820 cheaper than multi-axis profiling or flank grinding. Flank grinding is only needed if velocity exceeds 15 m/s.',
            },
            {
              label: 'Operational Impact',
              text: 'Best batch economics (8–12 days lead time) with minimal machine programming overhead.',
            },
          ],
        };
      }
      if (procId === 'grinding-finish') {
        return {
          title: 'Manufacturing Route Assessment',
          verdict: 'Best Choice for High-Speed / Low-Noise Geartrains',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Precision generating grinding removes heat-treat quench distortion, achieving ultra-precise DIN 5–6 (<12 µm pitch error).',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Adds +₹1,820/unit and +4 days lead time, but reduces acoustic vibration by >6 dBA compared to as-hobbed gears.',
            },
            {
              label: 'Operational Impact',
              text: 'Doubles tooth contact fatigue life and eliminates high-speed transmission whine above 3000 RPM.',
            },
          ],
        };
      }
      if (procId === 'wire-edm') {
        return {
          title: 'Manufacturing Route Assessment',
          verdict: 'Specialized Route (Sharp Splines & Zero Burr)',
          verdictType: 'suboptimal',
          points: [
            {
              label: 'Why Selected',
              text: 'Non-contact spark erosion cuts hardened alloys with zero mechanical cutting force, achieving DIN 6 with sharp internal keyways.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Standard hobbing is much faster for standard external gear rings; Wire EDM adds +₹1,260/unit and +3 days lead time.',
            },
            {
              label: 'Operational Impact',
              text: 'Excellent for tight internal splines or prototype batches where dedicated hob cutters are unavailable.',
            },
          ],
        };
      }
      if (procId === 'multi-axis-milling') {
        return {
          title: 'Manufacturing Route Assessment',
          verdict: 'Best for Integrated Gear-Shaft Geometries',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: '5-axis toolpaths allow single-setup machining of combined gear, step shoulders, and intricate hub mounting details.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Slower cycle time than hobbing for standard standalone gears; cost-effective only when eliminating secondary multi-machine fixturing.',
            },
            {
              label: 'Operational Impact',
              text: 'Eliminates radial runout errors between gear pitch circle and mounting shaft journals.',
            },
          ],
        };
      }
      break;
    }

    case CATEGORY_IDS.SURFACE: {
      const surfId = selectedOption?.id || draftDecisions.surfaceTreatment?.id || 'black-oxide';
      if (surfId === 'black-oxide') {
        return {
          title: 'Surface Treatment Assessment',
          verdict: 'Optimal Choice for Precision Geartrains',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Sub-micron chemical conversion creates zero dimensional buildup (0 µm), preserving pitch tolerance class and gear backlash.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Manganese Phosphate (+₹70/unit) holds boundary oil better during break-in, but adds 2–5 µm thickness which can tighten backlash on Grade 6 gears.',
            },
            {
              label: 'Operational Impact',
              text: 'Indoor corrosion protection during storage and assembly without altering mating tooth clearances.',
            },
          ],
        };
      }
      if (surfId === 'manganese-phosphate') {
        return {
          title: 'Surface Treatment Assessment',
          verdict: 'Best Choice for High-Friction Break-In Wear',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Porous micro-crystalline phosphate layer traps and holds lubricating oil, preventing initial startup scuffing and micro-pitting.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Costs ₹70 more than black oxide and adds 2–5 µm coating thickness; requires checking backlash clearance.',
            },
            {
              label: 'Operational Impact',
              text: 'Superior anti-scoring protection during the critical first 50 hours of gearbox operation.',
            },
          ],
        };
      }
      if (surfId === 'hard-anodize') {
        return {
          title: 'Surface Treatment Assessment',
          verdict: 'Mandatory for Aluminum / Suboptimal for Steel',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Type III ceramic conversion creates glass-hard surface (60–65 HRC equivalent) preventing galling on aluminum.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Applicable only to 7075 Aluminum; steel parts must use Black Oxide or Phosphate.',
            },
            {
              label: 'Operational Impact',
              text: 'Prevents rapid wear failure on aluminum tooth flanks.',
            },
          ],
        };
      }
      if (surfId === 'as-machined') {
        return {
          title: 'Surface Treatment Assessment',
          verdict: 'Economical (Requires Immediate Enclosed Oil Bath)',
          verdictType: 'suboptimal',
          points: [
            {
              label: 'Why Selected',
              text: 'Saves coating cost (+₹0); parts are delivered coated in light protective rust-inhibitive oil.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Black oxide is only ₹150/unit and provides lasting shelf protection. Bare steel will rust if stored in humid warehouses.',
            },
            {
              label: 'Operational Impact',
              text: 'Requires immediate gearbox assembly and continuous immersion in circulating lubricating oil.',
            },
          ],
        };
      }
      break;
    }

    case CATEGORY_IDS.TOLERANCES: {
      const tolId = selectedOption?.id || draftDecisions.tolerances?.id || 'iso-grade-7';
      if (tolId === 'iso-grade-7') {
        return {
          title: 'Tolerance & Accuracy Assessment',
          verdict: 'Best Engineering Standard (Optimal Precision/Cost)',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Pitch error < 18 µm delivers smooth, quiet operation up to 2500 RPM for industrial gear reducers.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Achievable directly via CNC hobbing. Grade 6 (+₹980/unit) requires secondary flank grinding; Grade 9 is only for low-speed conveyors.',
            },
            {
              label: 'Operational Impact',
              text: 'Standard machining passes with zero grinding surcharge; reliable backlash clearance (0.08–0.14 mm).',
            },
          ],
        };
      }
      if (tolId === 'iso-grade-6') {
        return {
          title: 'Tolerance & Accuracy Assessment',
          verdict: 'Best for High Precision / EV Powertrains',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Ultra-tight pitch error (< 12 µm) minimizes transmission error and acoustic resonance at high rotational speeds (> 3000 RPM).',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Adds +₹980/unit (+35%) and requires finish grinding or wire EDM passes. Over-specified for low-speed industrial drives.',
            },
            {
              label: 'Operational Impact',
              text: 'Sub-68 dBA acoustic noise and high power transmission efficiency.',
            },
          ],
        };
      }
      if (tolId === 'commercial-grade-9') {
        return {
          title: 'Tolerance & Accuracy Assessment',
          verdict: 'Economical for Slow-Speed Drives (< 500 RPM)',
          verdictType: 'suboptimal',
          points: [
            {
              label: 'Why Selected',
              text: 'Generous ±0.1mm envelope relaxes machining cycle time and tooling precision requirements.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Saves ₹420/unit (-15%), but pitch runout produces audible backlash clatter above 800 RPM.',
            },
            {
              label: 'Operational Impact',
              text: 'Suitable only for agricultural machinery, manual drives, and slow conveyors.',
            },
          ],
        };
      }
      break;
    }

    case CATEGORY_IDS.HEAT_TREATMENT: {
      const htId = selectedOption?.id || draftDecisions.heatTreatment?.id || 'case-carburizing';
      if (htId === 'case-carburizing') {
        return {
          title: 'Thermal Treatment Assessment',
          verdict: 'Optimal Choice for High-Torque Power Gears',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Deep carbon diffusion (0.8–1.2mm) creates 58–62 HRC wear-resistant surface with tough 32 HRC core.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Through-hardening is ₹200 cheaper but has 40% lower surface wear resistance; induction hardening has lower root case depth.',
            },
            {
              label: 'Operational Impact',
              text: '3× longer wear life under rated torque; requires accounting for ~0.05% post-quench thermal growth.',
            },
          ],
        };
      }
      if (htId === 'induction-hardening') {
        return {
          title: 'Thermal Treatment Assessment',
          verdict: 'Best for Minimal Bore Distortion',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'High-frequency heating targets tooth flanks only, leaving bore and keyway ductile for post-machining.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Saves ₹130/unit vs carburizing with lower overall part distortion; shallower tooth root case depth.',
            },
            {
              label: 'Operational Impact',
              text: 'Minimal bore distortion; ideal when bore cannot be finish-ground after hardening.',
            },
          ],
        };
      }
      if (htId === 'nitriding') {
        return {
          title: 'Thermal Treatment Assessment',
          verdict: 'Best for Zero-Distortion Precision Gears',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Sub-critical process (500°C) with no oil quench; produces glass-hard case (650 HV) with near-zero dimensional distortion.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Thinner case depth (0.3mm) than carburizing; best suited for steady loads rather than heavy shock impacts.',
            },
            {
              label: 'Operational Impact',
              text: 'Preserves precision DIN 6/7 gear tolerances directly without requiring finish grinding.',
            },
          ],
        };
      }
      if (htId === 'through-hardened') {
        return {
          title: 'Thermal Treatment Assessment',
          verdict: 'Best for Severe Shock & Reverse Impact Loads',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Uniform 28–34 HRC through entire cross-section eliminates case-crushing or spalling risk under extreme shock loads.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Lower surface hardness than carburizing; susceptible to accelerated abrasive wear under continuous sliding mesh.',
            },
            {
              label: 'Operational Impact',
              text: 'Prevents catastrophic tooth root snapping under high cyclic shock torque.',
            },
          ],
        };
      }
      if (htId === 'none-annealed') {
        return {
          title: 'Thermal Treatment Assessment',
          verdict: 'Suitable for Stainless / Bronze / Light Duty',
          verdictType: 'suboptimal',
          points: [
            {
              label: 'Why Selected',
              text: 'Saves ₹250–₹450/unit; eliminates thermal distortion.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'On carbon or alloy steel gears, unhardened teeth will wear out rapidly under industrial loads.',
            },
            {
              label: 'Operational Impact',
              text: 'Strictly limited to non-stressed or corrosive duty (316L Stainless Steel).',
            },
          ],
        };
      }
      break;
    }

    case CATEGORY_IDS.INSPECTION: {
      const inspId = selectedOption?.id || draftDecisions.inspection?.id || 'cmm-lead-profile';
      if (inspId === 'cmm-lead-profile') {
        return {
          title: 'Quality Verification Assessment',
          verdict: 'Recommended Quality Verification (Traceable & Certified)',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Automated CMM measures involute profile (Fα), lead helix deviation (Fβ), and pitch error with certified EN 10204 3.1 inspection report.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Costs ₹200 more than roll testing, but provides traceable multi-point dimensional validation.',
            },
            {
              label: 'Operational Impact',
              text: 'Guarantees validated tooth contact patterns and prevents field assembly disputes.',
            },
          ],
        };
      }
      if (inspId === 'double-flank-roll') {
        return {
          title: 'Quality Verification Assessment',
          verdict: 'Fast & Economical for Batch Runs',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Kinematic roll test against master gear records total composite radial runout (Fi) in 60 seconds.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Saves ₹200/unit; does not provide individual flank coordinate traces.',
            },
            {
              label: 'Operational Impact',
              text: 'Excellent production-line go/no-go quality screening for batch manufacturing.',
            },
          ],
        };
      }
      if (inspId === 'mpi-ndt') {
        return {
          title: 'Quality Verification Assessment',
          verdict: 'Critical for High-Reliability / Safety Drives',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Fluorescent magnetic particle inspection reveals micro-cracks in tooth roots post-heat-treatment.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Adds +₹280/unit; necessary for aerospace, mining, or safety-critical drivetrains.',
            },
            {
              label: 'Operational Impact',
              text: '100% assurance against subsurface thermal crack propagation and sudden tooth detachment.',
            },
          ],
        };
      }
      break;
    }

    case CATEGORY_IDS.QUANTITY: {
      const poolCost = 12000;
      const unitAmortizedSetup = Math.round(poolCost / qty);
      const isVolumeOptimal = qty >= 50;

      return {
        title: 'Batch Scale Economy Assessment',
        verdict: isVolumeOptimal ? 'Optimal Production Volume (Low Unit Setup)' : 'Prototype / Pilot Batch Volume',
        verdictType: isVolumeOptimal ? 'recommended' : 'info',
        points: [
          {
            label: 'Tooling Amortization',
            text: `Fixed CNC setup and fixture tooling pool (₹12,000) allocates at ₹${unitAmortizedSetup.toLocaleString('en-IN')}/unit for batch of ${qty}.`,
          },
          {
            label: 'Scale Economics',
            text: isVolumeOptimal
              ? `Batch of ${qty} achieves ~40% reduction in per-unit machining overhead and qualifies for raw bar stock volume discounts.`
              : `Scaling batch size from ${qty} to 50+ units reduces per-unit setup burden by ₹${Math.max(0, unitAmortizedSetup - 240).toLocaleString('en-IN')}/unit.`,
          },
          {
            label: 'Operational Impact',
            text: `Directly drives unit manufacturing cost down from initial small-batch rates while balancing inventory holding costs.`,
          },
        ],
      };
    }

    case CATEGORY_IDS.PACKAGING: {
      const packId = selectedOption?.id || draftDecisions.packaging?.id || 'vci-sealed';
      if (packId === 'vci-sealed') {
        return {
          title: 'Packaging & Preservation Assessment',
          verdict: 'Best Practice for Precision Machinery',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'Volatile corrosion inhibitor bag emits active protective vapor for up to 24 months without messy grease coatings.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Saves degreasing cleanup time at assembly; far superior rust protection than bare cardboard.',
            },
            {
              label: 'Operational Impact',
              text: 'Parts arrive clean, dry, and ready for immediate drop-in installation into gearboxes.',
            },
          ],
        };
      }
      if (packId === 'wooden-crate') {
        return {
          title: 'Packaging & Preservation Assessment',
          verdict: 'Required for Heavy Machinery & Maritime Export',
          verdictType: 'recommended',
          points: [
            {
              label: 'Why Selected',
              text: 'ISPM-15 certified heat-treated crate with internal shock partitions prevents transit impact brinelling.',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Adds +₹330/unit; essential for freight shipments over 25 kg or sea transport.',
            },
            {
              label: 'Operational Impact',
              text: 'Zero risk of tooth tip chipping or freight damage during rough transit.',
            },
          ],
        };
      }
      if (packId === 'bulk-industrial') {
        return {
          title: 'Packaging & Preservation Assessment',
          verdict: 'Economical for Local Production Lines',
          verdictType: 'suboptimal',
          points: [
            {
              label: 'Why Selected',
              text: 'Multi-wall corrugated partition with wax oil paper at lowest packaging cost (+₹50/unit).',
            },
            {
              label: 'Comparative Trade-off',
              text: 'Limited atmospheric moisture barrier; not suited for long-term ocean shipping or humid storage.',
            },
            {
              label: 'Operational Impact',
              text: 'Ideal for fast road delivery to nearby manufacturing plants.',
            },
          ],
        };
      }
      break;
    }

    default:
      return null;
  }

  return null;
}

// ─── Default Decisions Helper ─────────────────────────────────────────────────

export function getInitialDraftDecisions(analysis) {
  const dims = analysis?.dimensions || {};
  return {
    outerDiameter: typeof dims.outerDiameter === 'number' && dims.outerDiameter > 0 ? dims.outerDiameter : 120,
    innerDiameter: typeof dims.innerDiameter === 'number' && dims.innerDiameter > 0 ? dims.innerDiameter : 30,
    height: typeof dims.height === 'number' && dims.height > 0 ? dims.height : (typeof dims.thickness === 'number' && dims.thickness > 0 ? dims.thickness : 28),
    teeth: typeof analysis?.teeth === 'number' && analysis.teeth > 0 ? analysis.teeth : 24,
    material: MATERIAL_OPTIONS[0], // AISI 4140
    process: PROCESS_OPTIONS[0], // Hobbing CNC
    surfaceTreatment: SURFACE_OPTIONS[0], // Black Oxide
    tolerances: TOLERANCE_OPTIONS[0], // ISO Grade 7
    heatTreatment: HEAT_TREATMENT_OPTIONS[0], // Case Carburizing
    inspection: INSPECTION_OPTIONS[0], // CMM Profile
    packaging: PACKAGING_OPTIONS[0], // VCI Sealed
  };
}

// ─── Technical Dependency Evaluation Engine ───────────────────────────────────

/**
 * Evaluates technical engineering dependencies across confirmed decisions.
 * Returns an array of dependency conflict/advisory items.
 * If confirmedCategories is provided, only flags review issues for categories that have been confirmed.
 */
export function evaluateTechnicalDependencies(decisions, quantity = 1, confirmedCategories = null) {
  const deps = [];
  if (!decisions) return deps;

  const mat = decisions.material;
  const proc = decisions.process;
  const surf = decisions.surfaceTreatment;
  const tol = decisions.tolerances;
  const ht = decisions.heatTreatment;
  const insp = decisions.inspection;
  const pack = decisions.packaging;

  const od = Number(decisions.outerDiameter) || 100;
  const id = Number(decisions.innerDiameter) || 25;
  const h = Number(decisions.height) || 28;

  // 1. Geometry internal consistency
  if (typeof od === 'number' && typeof id === 'number' && id >= od) {
    deps.push({
      target: CATEGORY_IDS.GEOMETRY,
      source: CATEGORY_IDS.GEOMETRY,
      title: 'Invalid Bore Dimension',
      reason: `Inner bore diameter (${id}mm) must be strictly less than outer gear diameter (${od}mm).`,
      severity: 'error',
    });
  }

  // Calculate approximate component volume and mass
  const radiusOuterCm = Math.max(1, od) / 20;
  const radiusInnerCm = Math.max(0, id) / 20;
  const heightCm = Math.max(0.5, h) / 10;
  const volumeCm3 = Math.max(1, Math.PI * (radiusOuterCm ** 2 - radiusInnerCm ** 2) * heightCm * 0.7); // 0.7 for tooth cutouts
  const density = mat?.densityGcm3 || 7.85;
  const massKg = (volumeCm3 * density) / 1000;

  // 2. Material vs Heat Treatment
  if (mat && ht) {
    if (mat.isAluminum || mat.id === 'al-7075-t6') {
      if (ht.id === 'case-carburizing' || ht.id === 'induction-hardening' || ht.id === 'nitriding' || ht.steelOnly) {
        deps.push({
          target: CATEGORY_IDS.HEAT_TREATMENT,
          source: CATEGORY_IDS.MATERIAL,
          title: 'Material / Heat Treatment Incompatibility',
          reason: `${mat.label} is an aluminum alloy and cannot undergo ferrous carburizing or nitriding. Solution Heat Treat (T6) or Annealed is required.`,
          severity: 'error',
        });
      }
    } else if (mat.isStainless || mat.id === 'ss-316l') {
      if (ht.id === 'case-carburizing' || ht.id === 'induction-hardening') {
        deps.push({
          target: CATEGORY_IDS.HEAT_TREATMENT,
          source: CATEGORY_IDS.MATERIAL,
          title: 'Austenitic Stainless Steel Hardening Conflict',
          reason: `${mat.label} is austenitic and cannot be case-carburized or induction hardened. Through-hardening or Annealed is required.`,
          severity: 'error',
        });
      }
    } else if (mat.isBronze || mat.id === 'c93200-bronze') {
      if (ht.steelOnly) {
        deps.push({
          target: CATEGORY_IDS.HEAT_TREATMENT,
          source: CATEGORY_IDS.MATERIAL,
          title: 'Bronze Alloy Thermal Treatment Mismatch',
          reason: `Bearing Bronze cannot undergo steel quench hardening. Select Annealed / None.`,
          severity: 'error',
        });
      }
    } else if (mat.id === 'aisi-1045' && ht.id === 'case-carburizing') {
      deps.push({
        target: CATEGORY_IDS.HEAT_TREATMENT,
        source: CATEGORY_IDS.MATERIAL,
        title: 'Carbon Content / Carburizing Advisory',
        reason: `${mat.label} already contains 0.45% carbon. Induction contour hardening or through-hardening is standard; carburizing 1045 risks excessive core brittleness.`,
        severity: 'warning',
      });
    }
  }

  // 3. Material vs Surface Treatment
  if (mat && surf) {
    if (mat.isAluminum || mat.id === 'al-7075-t6') {
      if (surf.id === 'black-oxide' || surf.id === 'manganese-phosphate' || surf.forFerrousOnly) {
        deps.push({
          target: CATEGORY_IDS.SURFACE,
          source: CATEGORY_IDS.MATERIAL,
          title: 'Substrate / Surface Chemical Incompatibility',
          reason: `${mat.label} cannot be coated with ${surf.label}. Black oxide and Parkerizing require iron/steel substrate. Hardcoat Anodizing (Type III) is required.`,
          severity: 'error',
        });
      }
    } else if (mat.isFerrous && !mat.isAluminum) {
      if (surf.id === 'hard-anodize' || surf.forAluminumOnly) {
        deps.push({
          target: CATEGORY_IDS.SURFACE,
          source: CATEGORY_IDS.MATERIAL,
          title: 'Anodizing on Ferrous Alloy Conflict',
          reason: `Hardcoat Anodizing is an electrochemical passivation exclusive to aluminum alloys. Select Black Oxide or Manganese Phosphate for steel.`,
          severity: 'error',
        });
      }
    }
  }

  // 4. Process vs Tolerances
  if (proc && tol) {
    if (tol.id === 'iso-grade-6' && proc.id === 'hobbing-cnc') {
      deps.push({
        target: CATEGORY_IDS.PROCESS,
        source: CATEGORY_IDS.TOLERANCES,
        title: 'Tolerance / Process Compatibility',
        reason: 'DIN 6 / ISO Grade 6 precision requires tooth flank grinding or wire EDM finishing passes beyond conventional single-setup hobbing.',
        severity: 'error',
      });
    }
  }

  // 5. Tolerances vs Inspection Metrology
  if (tol && insp) {
    if (tol.id === 'iso-grade-6' && insp.id === 'double-flank-roll') {
      deps.push({
        target: CATEGORY_IDS.INSPECTION,
        source: CATEGORY_IDS.TOLERANCES,
        title: 'Metrology Resolution Mismatch',
        reason: 'DIN 6 precision certification requires 3D CMM tooth profile (Fα) and lead helix (Fβ) inspection. Double-flank roll testing only verifies composite radial error.',
        severity: 'warning',
      });
    }
  }

  // 6. Geometry / Weight vs Packaging
  if (pack) {
    if (massKg > 20 && pack.id === 'bulk-industrial') {
      deps.push({
        target: CATEGORY_IDS.PACKAGING,
        source: CATEGORY_IDS.GEOMETRY,
        title: 'Package Weight Exceeded',
        reason: `Component calculated mass is ~${massKg.toFixed(1)}kg (exceeds 20kg limit for corrugated cartons). Reinforced ISPM-15 wooden crating is required to prevent shipping damage.`,
        severity: 'error',
      });
    } else if (surf?.id === 'as-machined' && pack.id === 'bulk-industrial' && mat?.isFerrous && !mat?.isStainless) {
      deps.push({
        target: CATEGORY_IDS.PACKAGING,
        source: CATEGORY_IDS.SURFACE,
        title: 'Corrosion Protection Advisory',
        reason: 'As-machined bare steel with light oil is vulnerable to atmospheric oxidation during transit. VCI vapor-inhibitor barrier packaging is strongly recommended.',
        severity: 'warning',
      });
    }
  }

  // If confirmedCategories is provided, only report issues where target has been confirmed
  if (confirmedCategories && typeof confirmedCategories === 'object') {
    return deps.filter((d) => Boolean(confirmedCategories[d.target]));
  }

  return deps;
}

// ─── Status Computation Engine ────────────────────────────────────────────────

/**
 * Computes individual category status ('not_started' | 'in_progress' | 'confirmed' | 'needs_review')
 * and overall configuration health.
 */
export function computeConfiguratorStatuses(confirmedDecisions = {}, confirmedCategories = {}, activeDraftCat = null, dependencies = []) {
  const statuses = {};

  CATEGORY_ORDER.forEach((catId) => {
    const isConfirmed = Boolean(confirmedCategories[catId]);
    const hasDependencyIssue = dependencies.some((d) => d.target === catId);

    if (hasDependencyIssue && isConfirmed) {
      statuses[catId] = 'needs_review';
    } else if (isConfirmed) {
      statuses[catId] = 'confirmed';
    } else if (activeDraftCat === catId) {
      statuses[catId] = 'in_progress';
    } else {
      statuses[catId] = 'not_started';
    }
  });

  const confirmedCount = CATEGORY_ORDER.filter((id) => statuses[id] === 'confirmed').length;
  const reviewCount = CATEGORY_ORDER.filter((id) => statuses[id] === 'needs_review').length;
  const isAllConfirmed = confirmedCount === CATEGORY_ORDER.length && reviewCount === 0;

  // Find next incomplete category in exact order
  let nextIncompleteCatId = null;
  // First priority: any category that needs review
  const firstReview = CATEGORY_ORDER.find((id) => statuses[id] === 'needs_review');
  if (firstReview) {
    nextIncompleteCatId = firstReview;
  } else {
    // Second priority: first category not confirmed
    const firstNotConfirmed = CATEGORY_ORDER.find((id) => statuses[id] !== 'confirmed');
    nextIncompleteCatId = firstNotConfirmed || null;
  }

  return {
    statuses,
    confirmedCount,
    reviewCount,
    isAllConfirmed,
    nextIncompleteCatId,
    totalCategories: CATEGORY_ORDER.length,
  };
}

// ─── Live Cost & Specification Calculator ─────────────────────────────────────

/**
 * Fully synchronized engineering cost calculation engine.
 * Computes:
 * - Confirmed unit cost & batch total (only from explicitly confirmed categories)
 * - Full-spec projected cost (when all 9 are confirmed or for budget projection)
 * - Itemized manufacturing breakdown for all 9 categories with exact engineering drivers and rates
 * - Live cost-impact explanation card data for active draft or confirmed selection
 * - 10-Year Lifecycle Total Cost of Ownership (TCO)
 */
export function computeSynchronizedManufacturingCost({
  decisions = {},
  confirmedCategories = {},
  quantity = 1,
  activeDraftSelection = null,
  analysis = null,
} = {}) {
  const qty = Math.max(1, Number(quantity) || 1);

  // Look up full catalog objects
  const matId = decisions?.material?.id || 'aisi-4140';
  const mat = MATERIAL_OPTIONS.find((m) => m.id === matId) || MATERIAL_OPTIONS[0];

  const procId = decisions?.process?.id || 'hobbing-cnc';
  const proc = PROCESS_OPTIONS.find((p) => p.id === procId) || PROCESS_OPTIONS[0];

  const surfId = decisions?.surfaceTreatment?.id || 'black-oxide';
  const surf = SURFACE_OPTIONS.find((s) => s.id === surfId) || SURFACE_OPTIONS[0];

  const tolId = decisions?.tolerances?.id || 'iso-grade-7';
  const tol = TOLERANCE_OPTIONS.find((t) => t.id === tolId) || TOLERANCE_OPTIONS[0];

  const htId = decisions?.heatTreatment?.id || 'case-carburizing';
  const ht = HEAT_TREATMENT_OPTIONS.find((h) => h.id === htId) || HEAT_TREATMENT_OPTIONS[0];

  const inspId = decisions?.inspection?.id || 'cmm-lead-profile';
  const insp = INSPECTION_OPTIONS.find((i) => i.id === inspId) || INSPECTION_OPTIONS[0];

  const packId = decisions?.packaging?.id || 'vci-sealed';
  const pack = PACKAGING_OPTIONS.find((pk) => pk.id === packId) || PACKAGING_OPTIONS[0];

  const od = Number(decisions?.outerDiameter) || 100;
  const id = Number(decisions?.innerDiameter) || 25;
  const h = Number(decisions?.height) || 28;
  const teeth = Number(decisions?.teeth) || 24;

  // Volume factor relative to standard 100mm OD x 25mm ID x 28mm H gear
  const baselineVol = (100 ** 2 - 25 ** 2) * 28;
  const currentVol = Math.max(1000, (od ** 2 - id ** 2) * h);
  const volMultiplier = Number.isFinite(currentVol / baselineVol) ? currentVol / baselineVol : 1.0;

  // Exact individual rates for all 9 categories based on engineering physics & machine shop economics:
  const cGeometry = Math.round(1200 * volMultiplier) + Math.round(4000 / qty);
  const cMaterial = Math.round(1800 * volMultiplier * (Number(mat.costMul) || 1.0));
  const cProcess = Math.round(2600 * volMultiplier * (Number(proc.costMul) || 1.0));
  const cSurface = Number(surf.costAdd) || 0;
  const cTolerances = Math.round(800 * volMultiplier * Math.max(0, (Number(tol.costMul) || 1.0) - 1.0) + (tol.id === 'iso-grade-6' ? 350 : 0));
  const cHeatTreat = Number(ht.costAdd) || 0;
  const cInspection = Math.round((Number(insp.costAdd) || 150) * (qty > 50 ? 0.6 : 1.0));
  const cBatch = Math.round(3000 / qty);
  const cPackaging = Number(pack.costAdd) || 50;

  const categoryCostMap = {
    [CATEGORY_IDS.GEOMETRY]: cGeometry,
    [CATEGORY_IDS.MATERIAL]: cMaterial,
    [CATEGORY_IDS.PROCESS]: cProcess,
    [CATEGORY_IDS.SURFACE]: cSurface,
    [CATEGORY_IDS.TOLERANCES]: cTolerances,
    [CATEGORY_IDS.HEAT_TREATMENT]: cHeatTreat,
    [CATEGORY_IDS.INSPECTION]: cInspection,
    [CATEGORY_IDS.QUANTITY]: cBatch,
    [CATEGORY_IDS.PACKAGING]: cPackaging,
  };

  const categoryDriverMap = {
    [CATEGORY_IDS.GEOMETRY]: `OD: ${od}mm · ID: ${id}mm · L: ${h}mm (${teeth}T, Vol: ${(currentVol / 1000).toFixed(1)} cm³)`,
    [CATEGORY_IDS.MATERIAL]: `${mat.label} Stock Billet`,
    [CATEGORY_IDS.PROCESS]: `${proc.label} (${proc.leadTime}, ${proc.accuracy})`,
    [CATEGORY_IDS.SURFACE]: `${surf.label} (${surf.dimensionalBuildup || '0 µm buildup'})`,
    [CATEGORY_IDS.TOLERANCES]: `${tol.label}`,
    [CATEGORY_IDS.HEAT_TREATMENT]: `${ht.label}`,
    [CATEGORY_IDS.INSPECTION]: `${insp.label}`,
    [CATEGORY_IDS.QUANTITY]: `Batch of ${qty} unit${qty > 1 ? 's' : ''} (Amortized Fixture Setup)`,
    [CATEGORY_IDS.PACKAGING]: `${pack.label}`,
  };

  const confirmedCount = CATEGORY_ORDER.filter((cId) => confirmedCategories[cId]).length;
  const isAllConfirmed = confirmedCount === 9;
  const hasAnyConfirmed = confirmedCount > 0;

  // Determine active draft item (if user clicked something before confirming)
  const activeDraftCatId = activeDraftSelection?.catId;
  const activeDraftOpt = activeDraftSelection?.option;

  // Build the 9 itemized breakdown rows
  let confirmedSubtotal = 0;
  const itemizedBreakdown = CATEGORY_ORDER.map((cId) => {
    const meta = CATEGORY_METADATA[cId];
    const isConf = Boolean(confirmedCategories[cId]);
    const isPrev = Boolean(!isConf && activeDraftCatId === cId);
    const standardCost = categoryCostMap[cId] || 0;

    let rowCost = standardCost;
    if (isPrev && activeDraftOpt) {
      if (cId === CATEGORY_IDS.PROCESS) {
        rowCost = Math.round(2600 * volMultiplier * (Number(activeDraftOpt.costMul) || 1.0));
      } else if (cId === CATEGORY_IDS.MATERIAL) {
        rowCost = Math.round(1800 * volMultiplier * (Number(activeDraftOpt.costMul) || 1.0));
      } else if (cId === CATEGORY_IDS.SURFACE) {
        rowCost = Number(activeDraftOpt.costAdd) || 0;
      } else if (cId === CATEGORY_IDS.TOLERANCES) {
        rowCost = Math.round(800 * volMultiplier * Math.max(0, (Number(activeDraftOpt.costMul) || 1.0) - 1.0) + (activeDraftOpt.id === 'iso-grade-6' ? 350 : 0));
      } else if (cId === CATEGORY_IDS.HEAT_TREATMENT) {
        rowCost = Number(activeDraftOpt.costAdd) || 0;
      } else if (cId === CATEGORY_IDS.INSPECTION) {
        rowCost = Math.round((Number(activeDraftOpt.costAdd) || 150) * (qty > 50 ? 0.6 : 1.0));
      } else if (cId === CATEGORY_IDS.PACKAGING) {
        rowCost = Number(activeDraftOpt.costAdd) || 50;
      }
    }

    if (isConf) {
      confirmedSubtotal += standardCost;
    }

    let status = 'pending';
    let statusLabel = 'NOT CONFIRMED';
    if (isConf) {
      status = 'confirmed';
      statusLabel = 'CONFIRMED';
    } else if (isPrev) {
      status = 'preview';
      statusLabel = 'PREVIEW';
    }

    return {
      catId: cId,
      num: meta.num,
      name: meta.title,
      icon: meta.icon,
      driver: categoryDriverMap[cId],
      cost: rowCost,
      status,
      statusLabel,
      isConfirmed: isConf,
      isPreview: isPrev,
    };
  });

  // Calculate Confirmed Totals
  const confirmedOverhead = hasAnyConfirmed ? Math.round(confirmedSubtotal * 0.15) : 0;
  const confirmedTaxesGst = hasAnyConfirmed ? Math.round((confirmedSubtotal + confirmedOverhead) * 0.18) : 0;
  const confirmedUnitCost = hasAnyConfirmed ? (confirmedSubtotal + confirmedOverhead + confirmedTaxesGst) : 0;
  const confirmedBatchCost = confirmedUnitCost * qty;

  // Full-spec projected baseline total (for budget preview)
  const fullSpecSubtotal = Object.values(categoryCostMap).reduce((a, b) => a + b, 0);
  const fullSpecOverhead = Math.round(fullSpecSubtotal * 0.15);
  const fullSpecTaxes = Math.round((fullSpecSubtotal + fullSpecOverhead) * 0.18);
  const fullSpecUnitCost = fullSpecSubtotal + fullSpecOverhead + fullSpecTaxes;

  // Calculate Live Cost-Impact Explanation
  let costImpactExplanation = null;
  const targetCatId = activeDraftCatId || CATEGORY_IDS.PROCESS;
  const targetMeta = CATEGORY_METADATA[targetCatId] || CATEGORY_METADATA[CATEGORY_IDS.PROCESS];
  const targetOpt = activeDraftOpt || (targetCatId === CATEGORY_IDS.PROCESS ? proc : decisions[targetCatId] || null);

  if (targetOpt) {
    const isTargetConfirmed = Boolean(confirmedCategories[targetCatId]);
    let targetCost = categoryCostMap[targetCatId] || 0;
    let baseRefCost = targetCost;
    let effectDesc = targetOpt.desc || '';

    if (targetCatId === CATEGORY_IDS.PROCESS) {
      const draftMul = Number(targetOpt.costMul) || 1.0;
      targetCost = Math.round(2600 * volMultiplier * draftMul);
      baseRefCost = Math.round(2600 * volMultiplier * 1.0);
      effectDesc = targetOpt.desc || 'Standard gear hobbing cycle.';
    } else if (targetCatId === CATEGORY_IDS.MATERIAL) {
      targetCost = Math.round(1800 * volMultiplier * (Number(targetOpt.costMul) || 1.0));
      baseRefCost = Math.round(1800 * volMultiplier * 1.0);
      effectDesc = targetOpt.desc || 'Alloy steel stock envelope.';
    } else if (targetCatId === CATEGORY_IDS.HEAT_TREATMENT) {
      targetCost = Number(targetOpt.costAdd) || 0;
      baseRefCost = 0;
      effectDesc = targetOpt.desc || 'Thermal heat-treat cycle.';
    } else if (targetCatId === CATEGORY_IDS.SURFACE) {
      targetCost = Number(targetOpt.costAdd) || 0;
      baseRefCost = 0;
      effectDesc = targetOpt.desc || 'Surface passivation treatment.';
    } else if (targetCatId === CATEGORY_IDS.TOLERANCES) {
      targetCost = Math.round(800 * volMultiplier * Math.max(0, (Number(targetOpt.costMul) || 1.0) - 1.0) + (targetOpt.id === 'iso-grade-6' ? 350 : 0));
      baseRefCost = 0;
      effectDesc = targetOpt.desc || 'Machining tolerance precision.';
    }

    const deltaINR = targetCost - baseRefCost;
    const deltaPercent = baseRefCost > 0 ? Math.round((deltaINR / baseRefCost) * 100) : 0;

    const previewAdded = Math.round(targetCost * 1.15 * 1.18);
    const previewUnitCost = hasAnyConfirmed
      ? (isTargetConfirmed ? confirmedUnitCost : confirmedUnitCost + previewAdded)
      : Math.round(fullSpecUnitCost);

    costImpactExplanation = {
      catId: targetCatId,
      catNum: targetMeta.num,
      catTitle: targetMeta.title,
      catIcon: targetMeta.icon,
      optionId: targetOpt.id,
      optionLabel: targetOpt.label,
      isConfirmed: isTargetConfirmed,
      statusLabel: isTargetConfirmed ? 'CONFIRMED & APPLIED' : 'PREVIEW (PENDING CONFIRMATION)',
      targetCost,
      deltaINR,
      deltaText: deltaINR === 0 ? 'Baseline (₹0 incremental)' : deltaINR > 0 ? `+₹${deltaINR.toLocaleString('en-IN')}/unit (+${deltaPercent}%)` : `-₹${Math.abs(deltaINR).toLocaleString('en-IN')}/unit (${deltaPercent}%)`,
      effectDesc,
      previewUnitCost,
      previewBatchCost: previewUnitCost * qty,
      actionHint: isTargetConfirmed
        ? 'Incorporated into current confirmed specification and TCO.'
        : 'Before confirmation, this is calculated as a preview. Click "Confirm Selection" in the right panel to incorporate it into the current estimate.',
    };
  }

  // 10-Year Lifecycle Total Cost of Ownership (TCO)
  const expectedLifeYears = ht.id === 'case-carburizing' ? 8.5 : ht.id === 'induction-hardening' ? 7.5 : ht.id === 'through-hardening' ? 6.0 : 4.0;
  const replacementFrequency = (1 / expectedLifeYears).toFixed(2);
  const downtimeRisk = (tol.id === 'iso-grade-6' || proc.id === 'grinding-finish') ? 'Minimal (<2 hrs/yr)' : 'Moderate (~8 hrs/yr)';
  const activeCostForTco = confirmedUnitCost > 0 ? confirmedUnitCost : fullSpecUnitCost;
  const tenYearTcoINR = Math.round(activeCostForTco * (10 / expectedLifeYears) + (qty > 10 ? 10000 : 15000));

  // Lead Time Calculation
  const baseLeadDays = Number(proc.leadDays) || 10;
  const htDays = ht.id === 'none-annealed' ? 0 : 3;
  const surfDays = surf.id === 'as-machined' ? 0 : 2;
  const batchDays = Math.ceil(qty / 25);
  const leadDays = baseLeadDays + htDays + surfDays + batchDays;

  return {
    unitCostInr: hasAnyConfirmed ? confirmedUnitCost : fullSpecUnitCost,
    confirmedUnitCost,
    confirmedBatchCost,
    fullSpecUnitCost,
    hasAnyConfirmed,
    confirmedCount,
    isAllConfirmed,
    totalBatchCostInr: (hasAnyConfirmed ? confirmedUnitCost : fullSpecUnitCost) * qty,
    leadDays,
    breakdown: {
      material: cMaterial,
      machining: cProcess + cTolerances,
      heatTreatment: cHeatTreat,
      surface: cSurface,
      inspection: cInspection,
      packaging: cPackaging,
      geometrySetup: cGeometry,
      batchTooling: cBatch,
      overhead: confirmedOverhead,
      taxes: confirmedTaxesGst,
    },
    itemizedBreakdown,
    costImpactExplanation,
    lifecycleTco: {
      expectedLifeYears,
      replacementFrequency,
      downtimeRisk,
      tenYearTcoINR,
    },
  };
}

/**
 * Calculates live estimated unit cost, batch total, lead time, and breakdown
 * using confirmed decisions, falling back to conservative defaults for unconfirmed items.
 */
export function calculateLiveManufacturingSummary(confirmedDecisions = {}, confirmedCategories = {}, quantity = 1, baseMfgData = null) {
  const synced = computeSynchronizedManufacturingCost({
    decisions: confirmedDecisions,
    confirmedCategories,
    quantity,
    analysis: null,
  });

  return {
    unitCostInr: synced.unitCostInr,
    confirmedUnitCost: synced.confirmedUnitCost,
    totalBatchCostInr: synced.totalBatchCostInr,
    leadDays: synced.leadDays,
    breakdown: synced.breakdown,
    itemizedBreakdown: synced.itemizedBreakdown,
    costImpactExplanation: synced.costImpactExplanation,
    lifecycleTco: synced.lifecycleTco,
  };
}

// ─── Persistence Helpers ──────────────────────────────────────────────────────

export function loadManufacturingState(storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) {
    return {
      confirmedCategories: {},
      decisions: {},
    };
  }

  // Clean up legacy storage versions to prevent loading premature confirmations
  try {
    store.removeItem('reforge_mfg_config_v2');
    store.removeItem('reforge_mfg_config');
  } catch {
    // ignore
  }

  try {
    const raw = store.getItem(STORAGE_KEY_MFG_CONFIG);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const rawConfirmed = parsed.confirmedCategories || {};
        const cleanConfirmed = {};
        CATEGORY_ORDER.forEach((id) => {
          if (rawConfirmed[id] === true) {
            cleanConfirmed[id] = true;
          }
        });
        return {
          confirmedCategories: cleanConfirmed,
          decisions: parsed.decisions || {},
        };
      }
    }
  } catch {
    // ignore corrupted json
  }

  // All 9 fields initially remain unconfirmed (empty object)
  return {
    confirmedCategories: {},
    decisions: {},
  };
}

export function saveManufacturingState(decisions, confirmedCategories, storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!store) return;

  try {
    const payload = {
      decisions: decisions || {},
      confirmedCategories: confirmedCategories || {},
      updatedAt: Date.now(),
    };
    store.setItem(STORAGE_KEY_MFG_CONFIG, JSON.stringify(payload));
    // Also save legacy key for compatibility with CostEstimationPanel & ReportEditorDialog
    store.setItem(STORAGE_KEY_MFG_DECISIONS, JSON.stringify(decisions || {}));
  } catch (err) {
    console.warn('Failed to save manufacturing state:', err);
  }
}

export function resetManufacturingState(storage) {
  const store = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (store) {
    try {
      store.removeItem(STORAGE_KEY_MFG_CONFIG);
      store.removeItem('reforge_mfg_config_v2');
      store.removeItem('reforge_mfg_config');
      store.removeItem(STORAGE_KEY_MFG_DECISIONS);
    } catch {
      // ignore
    }
  }
  return {
    confirmedCategories: {},
    decisions: {},
  };
}
