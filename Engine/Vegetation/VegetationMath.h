/*============================================================================================================================================
                                                        VEGETATIONMATH.H
============================================================================================================================================*/
// Dependency-free vector helpers for the vegetation porting scaffold.
// Local space is Y-up, matching the Slate generator. The engine interchange converts (X, Y, Z)_Slate
// to (X, -Z, Y)_Frontier at scene insertion, preserving right-handed orientation.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace Frontier::Vegetation
{

struct Vec3
{
    float X = 0.0f;
    float Y = 0.0f;
    float Z = 0.0f;

    constexpr Vec3() noexcept = default;
    constexpr Vec3(float InX, float InY, float InZ) noexcept : X(InX), Y(InY), Z(InZ) {}

    constexpr Vec3 operator+(const Vec3& Other) const noexcept { return {X + Other.X, Y + Other.Y, Z + Other.Z}; }
    constexpr Vec3 operator-(const Vec3& Other) const noexcept { return {X - Other.X, Y - Other.Y, Z - Other.Z}; }
    constexpr Vec3 operator*(float Scalar) const noexcept { return {X * Scalar, Y * Scalar, Z * Scalar}; }
};

[[nodiscard]] constexpr float Dot(const Vec3& A, const Vec3& B) noexcept
{
    return A.X * B.X + A.Y * B.Y + A.Z * B.Z;
}

[[nodiscard]] constexpr Vec3 Cross(const Vec3& A, const Vec3& B) noexcept
{
    return {A.Y * B.Z - A.Z * B.Y, A.Z * B.X - A.X * B.Z, A.X * B.Y - A.Y * B.X};
}

[[nodiscard]] inline float Length(const Vec3& Value) noexcept
{
    return std::sqrt(Dot(Value, Value));
}

[[nodiscard]] inline Vec3 Normalize(const Vec3& Value) noexcept
{
    const float Magnitude = Length(Value);
    return Magnitude > 1.0e-8f ? Value * (1.0f / Magnitude) : Vec3 {1.0f, 0.0f, 0.0f};
}

[[nodiscard]] inline float Radians(float Degrees) noexcept
{
    return Degrees * 3.14159265358979323846f / 180.0f;
}

[[nodiscard]] constexpr float Clamp(float Value, float Minimum, float Maximum) noexcept
{
    return std::clamp(Value, Minimum, Maximum);
}

// Deterministic per-instance phase. Identical on CPU, GPU ports and in the HTML demo.
[[nodiscard]] inline float Hash01(uint32_t Seed) noexcept
{
    uint32_t State = Seed * 747796405u + 2891336453u;
    State = ((State >> ((State >> 28u) + 4u)) ^ State) * 277803737u;
    State = (State >> 22u) ^ State;
    return static_cast<float>(State & 0x00FFFFFFu) / static_cast<float>(0x01000000u);
}

// Polynomial smooth minimum used when analytic tree proxies join the global distance field.
[[nodiscard]] inline float SmoothMinimum(float A, float B, float Smoothing) noexcept
{
    if (Smoothing <= 0.0f)
    {
        return std::min(A, B);
    }
    const float H = Clamp(0.5f + 0.5f * (B - A) / Smoothing, 0.0f, 1.0f);
    return B + (A - B) * H - Smoothing * H * (1.0f - H);
}

// Rodrigues rotation; identical to rotateAroundAxis() in Slate src/viewer/shaders.ts.
[[nodiscard]] inline Vec3 RotateAroundAxis(const Vec3& Point, const Vec3& Axis, float Angle) noexcept
{
    const float Cosine = std::cos(Angle);
    const float Sine = std::sin(Angle);
    return Point * Cosine + Cross(Axis, Point) * Sine + Axis * Dot(Axis, Point) * (1.0f - Cosine);
}

} // namespace Frontier::Vegetation
