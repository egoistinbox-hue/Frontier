#!/usr/bin/env bash
# Compile and run the dependency-free vegetation porting scaffold checks.
set -euo pipefail
cd "$(dirname "$0")/.."
g++ -std=c++20 -Wall -Wextra -I. \
    tests/VegetationCoreTest.cpp \
    Engine/Vegetation/WindFieldSolver.cpp \
    Engine/Vegetation/VegetationPresetCatalog.cpp \
    Engine/Vegetation/CanopyDeformer.cpp \
    Engine/Vegetation/ClusterLodSelector.cpp \
    Engine/Vegetation/DistanceProxySet.cpp \
    -o /tmp/frontier-vegetation-core-test
/tmp/frontier-vegetation-core-test
