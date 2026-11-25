# Frontier — vegetation porting lab

This branch is the **Untitled** vegetation prototype: a C++20 porting scaffold, a self-contained HTML reference demo, and the architecture decisions behind both.

```bash
bash scripts/build_vegetation_core.sh          # compile + run C++ checks
python3 scripts/build_markdown_studio.py       # rebuild the Markdown Studio viewer
```

| Path | What it is |
| :-- | :-- |
| [`docs/VegetationPortPlan.md`](docs/VegetationPortPlan.md) | Full design: wind field, all presets, UV unwrap, cluster LOD, leaf VAT/XPBD, fracture, SDF strategy, 10k forest, editor UI |
| [`demos/tree-generator/index.html`](demos/tree-generator/index.html) | Interactive Frontier/Project-Zero-style editor demo (outliner, inspector, five viewport modes) |
| [`demos/tree-generator/markdown-studio.html`](demos/tree-generator/markdown-studio.html) | Markdown Studio view of the design document (no server required) |
| [`Engine/Vegetation/`](Engine/Vegetation/) | Standalone C++20 units: shared wind solver, 51 presets, canopy deformer, cluster cut, SDF proxies, fracture specification, instance register |
| [`Engine/Shaders/Vegetation/TreeSway.slang`](Engine/Shaders/Vegetation/TreeSway.slang) | GPU mirror of the CPU wind deformer |
| [`tests/VegetationCoreTest.cpp`](tests/VegetationCoreTest.cpp) | Verification for 10 000 instances and the wind → mesh → SDF pipeline |

Sources consulted: Slate branch `arena/01a096c9-slate` (tree generator) and Frontier branch `arena/d929ef36-frontier` (editor UI, cluster LOD, fracture, SDF, wind inspector). See the document appendix for the exact files.
