/*============================================================================================================================================
                                                         TREESWAY.SLANG
============================================================================================================================================*/
// GPU path for the vegetation wind deformer. Mirrors CanopyDeformer.cpp and Slate src/viewer/shaders.ts.
// One WindField constant buffer serves every instance; per-instance phase/scale come from the instance record.

float3 RotateAroundAxis(float3 P, float3 Axis, float Angle)
{
    float C = cos(Angle);
    float S = sin(Angle);
    return P * C + cross(Axis, P) * S + Axis * dot(Axis, P) * (1.0f - C);
}

float WindWave(float T)
{
    return sin(T) * 0.7f + sin(T * 2.31f + 1.3f) * 0.2f + sin(T * 4.7f + 0.7f) * 0.1f;
}

// aWind = (height, limb, phase, detail); aPivot = limb root in object space.
// windVelocity is sampled once per instance from the shared WindFieldSolver.
float3 ApplyTreeWind(
    float3 Position,
    float3 Pivot,
    float4 aWind,
    float3 windVelocity,
    float windGust,
    float windTurbulence,
    float trunkFlex,
    float limbFlex,
    float detailFlex,
    float treeHeightM,
    float timeSeconds)
{
    float3 Dir = normalize(float3(windVelocity.x, 0.0f, windVelocity.z) + float3(1e-4f, 0.0f, 0.0f));
    float3 Side = normalize(cross(float3(0.0f, 1.0f, 0.0f), Dir));

    float Gust = 0.5f + 0.5f * WindWave(timeSeconds * 0.6f - aWind.x * 0.8f);
    Gust = 0.6f + 0.4f * Gust;
    Gust *= 1.0f + windGust * (0.5f + 0.5f * sin(timeSeconds * 0.23f));
    float Strength = min(length(windVelocity) + windTurbulence, 40.0f) * Gust;

    float3 P = Position;
    if (aWind.y > 0.0f)
    {
        float3 Rel = P - Pivot;
        float Ph = aWind.z * 6.2831f;
        float W = aWind.y * aWind.y;
        float Angle = limbFlex * Strength * 0.12f * W * (WindWave(timeSeconds * 1.3f + Ph) * 0.8f + 0.5f);
        float3 Axis = normalize(Side + float3(1e-4f, 0.0f, 0.0f));
        Rel = RotateAroundAxis(Rel, Axis, Angle);
        Rel = RotateAroundAxis(Rel, Dir, Angle * 0.35f * sin(timeSeconds * 0.9f + Ph * 1.7f));
        P = Pivot + Rel;
    }

    if (aWind.w > 0.0f)
    {
        float Flutter = aWind.w * detailFlex * Strength;
        float Ph = aWind.z * 12.566f + P.x * 3.1f + P.z * 2.7f;
        P += Side * (sin(timeSeconds * 7.3f + Ph) * 0.02f * Flutter);
        P.y += sin(timeSeconds * 5.1f + Ph * 1.3f) * 0.015f * Flutter;
        P += Dir * (sin(timeSeconds * 6.2f + Ph * 0.7f) * 0.02f * Flutter);
    }

    float Sway = trunkFlex * Strength * 0.035f * aWind.x * aWind.x * treeHeightM;
    float T = WindWave(timeSeconds * 0.85f) * 0.7f + 0.3f;
    P += Dir * (Sway * T);
    P += Side * (Sway * 0.2f * WindWave(timeSeconds * 0.55f + 2.0f));
    return P;
}
