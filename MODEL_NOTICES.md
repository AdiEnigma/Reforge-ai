# Model Notices — ReForge AI Vision Engine

This document provides license, provenance, and operational notices for AI models integrated into the ReForge AI vision preprocessing pipeline.

---

## 1. SAM 2.1 (Segment Anything Model 2.1)

| Attribute | Details |
| :--- | :--- |
| **Originating Organization** | Meta AI Research (FAIR) |
| **Upstream Repository** | [facebookresearch/sam2](https://github.com/facebookresearch/sam2) |
| **Pinned Release / Tag** | `v1.0` |
| **Model Variant Used** | `sam2.1_hiera_small` (~46M parameters) |
| **Checkpoint Filename** | `sam2.1_hiera_small.pt` |
| **Model Config Filename** | `sam2.1_hiera_s.yaml` |
| **Direct Download URL** | `https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt` |
| **SHA256 Checksum** | `47333a5cf0f23ba5b550dd7eb762b322a30ba5be669b7b9db893444458514930` |
| **License** | **Apache License 2.0** |

### Scope & Constraints
- SAM 2 is used to isolate mechanical components from uploaded photographs and produce candidate binary masks.
- Output masks are treated strictly as **segmentation hypotheses**, not guaranteed CAD boundaries.
- Post-processing conservatively preserves internal holes, bores, and slots; morphological operations that fill cavities are disabled.
- In multi-object or ambiguous scenes, the pipeline flags `needs_user_selection = true` rather than guessing.

---

## 2. Depth Anything V2 Small

| Attribute | Details |
| :--- | :--- |
| **Originating Organization** | TikTok / Depth Anything Team |
| **Upstream Repository** | [DepthAnything/Depth-Anything-V2](https://github.com/DepthAnything/Depth-Anything-V2) |
| **Hugging Face Model Card** | [depth-anything/Depth-Anything-V2-Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small) |
| **Model Variant Used** | **Small (`vits`) ONLY** (~24.8M parameters) |
| **Checkpoint Filename** | `depth_anything_v2_vits.pth` |
| **Direct Download URL** | `https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/main/depth_anything_v2_vits.pth` |
| **SHA256 Checksum** | `5c4232ec39178c772e0989f6d4d12543e33918aa08381dd00676451e6ba5f617` |
| **License** | **Apache License 2.0** *(Small variant only)* |

> [!WARNING]
> **Commercial Licensing Constraint**: Only the **Small (`vits`)** checkpoint is released under the **Apache-2.0** license.
> The Base, Large, and Giant checkpoints are distributed under the **CC-BY-NC-4.0** non-commercial license.
> **Do not download or substitute Base, Large, or Giant checkpoints in commercial or MSME deployments of ReForge AI.**

> [!IMPORTANT]
> **Relative Depth Non-Metric Notice**:
> Depth Anything V2 produces **relative inverse-depth representations**, NOT metric measurements.
> - Output values are unitless rankings of relative distance.
> - Output values **must never be interpreted as millimetres (mm)** or used directly to establish CAD dimensions, plate thickness, face width, or bore depth.
> - All API responses containing depth data explicitly return `depth_type: "relative"` and `metric: false`.

---

## 3. Storage and Repository Integrity

- Weight files (`*.pt`, `*.pth`) are **strictly excluded from version control** via `.gitignore`.
- Run `python vision-engine/scripts/download_models.py` to fetch checkpoints with checksum verification.
- Temporary preview tensors and generated mask artifacts are cleaned immediately or purged on process completion.

