// ===================================================
// Reference pixel shader for the Slug algorithm ported to WGSL
// This code is made available under the MIT License.
// Copyright 2017, by Eric Lengyel.
// ===================================================


// The curve and band textures use a fixed width of 4096 texels.

const kLogBandTextureWidth: u32 = 12u;

// It's convenient to have a texel load function to aid in translation to other shader languages.

fn TexelLoad2D_f32(tex: texture_2d<f32>, coords: vec2<i32>) -> vec4<f32> {
    return textureLoad(tex, coords, 0);
}

fn TexelLoad2D_u32(tex: texture_2d<u32>, coords: vec2<i32>) -> vec4<u32> {
    return textureLoad(tex, coords, 0);
}


fn CalcRootCode(y1: f32, y2: f32, y3: f32) -> u32 {
    // Calculate the root eligibility code for a sample-relative quadratic Bézier curve.
    // Extract the signs of the y coordinates of the three control points.

    let i1 = bitcast<u32>(y1) >> 31u;
    let i2 = bitcast<u32>(y2) >> 30u;
    let i3 = bitcast<u32>(y3) >> 29u;

    let shift = (i3 & 4u) | (((i2 & 2u) | (i1 & ~2u)) & ~4u);

    // Eligibility is returned in bits 0 and 8.

    return ((0x2E74u >> shift) & 0x0101u);
}

fn SolveHorizPoly(p12: vec4<f32>, p3: vec2<f32>) -> vec2<f32> {
    // Solve for the values of t where the curve crosses y = 0.
    // The quadratic polynomial in t is given by
    //
    //     a t^2 - 2b t + c,
    //
    // where a = p1.y - 2 p2.y + p3.y, b = p1.y - p2.y, and c = p1.y.
    // The discriminant b^2 - ac is clamped to zero, and imaginary
    // roots are treated as a double root at the global minimum
    // where t = b / a.

    let a = vec2<f32>(p12.x - p12.z * 2.0 + p3.x, p12.y - p12.w * 2.0 + p3.y);
    let b = vec2<f32>(p12.x - p12.z, p12.y - p12.w);
    let ra = 1.0 / a.y;
    let rb = 0.5 / b.y;

    let d = sqrt(max(b.y * b.y - a.y * p12.y, 0.0));
    var t1 = (b.y - d) * ra;
    var t2 = (b.y + d) * ra;

    // If the polynomial is nearly linear, then solve -2b t + c = 0.

    if (abs(a.y) < 1.0 / 65536.0) {
        t1 = p12.y * rb;
        t2 = p12.y * rb;
    }

    // Return the x coordinates where C(t) = 0.

    return vec2<f32>((a.x * t1 - b.x * 2.0) * t1 + p12.x, (a.x * t2 - b.x * 2.0) * t2 + p12.x);
}

fn SolveVertPoly(p12: vec4<f32>, p3: vec2<f32>) -> vec2<f32> {
    // Solve for the values of t where the curve crosses x = 0.

    let a = vec2<f32>(p12.x - p12.z * 2.0 + p3.x, p12.y - p12.w * 2.0 + p3.y);
    let b = vec2<f32>(p12.x - p12.z, p12.y - p12.w);
    let ra = 1.0 / a.x;
    let rb = 0.5 / b.x;

    let d = sqrt(max(b.x * b.x - a.x * p12.x, 0.0));
    var t1 = (b.x - d) * ra;
    var t2 = (b.x + d) * ra;

    // If the polynomial is nearly linear, then solve -2b t + c = 0.

    if (abs(a.x) < 1.0 / 65536.0) {
        t1 = p12.x * rb;
        t2 = p12.x * rb;
    }

    // Return the y coordinates where C(t) = 0.

    return vec2<f32>((a.y * t1 - b.y * 2.0) * t1 + p12.y, (a.y * t2 - b.y * 2.0) * t2 + p12.y);
}

fn CalcBandLoc(glyphLoc: vec2<i32>, offset: u32) -> vec2<i32> {
    // If the offset causes the x coordinate to exceed the texture width, then wrap to the next line.

    var bandLoc = vec2<i32>(glyphLoc.x + i32(offset), glyphLoc.y);
    bandLoc.y += bandLoc.x >> kLogBandTextureWidth;
    bandLoc.x &= (1 << kLogBandTextureWidth) - 1;
    return bandLoc;
}

// Override constants for optional features.
// Set SLUG_EVENODD = true to enable even-odd fill rule support.
// Set SLUG_WEIGHT = true to enable optical weight boost via square root.

override SLUG_EVENODD: bool = false;
override SLUG_WEIGHT: bool = false;

fn CalcCoverage(xcov: f32, ycov: f32, xwgt: f32, ywgt: f32, flags: i32) -> f32 {
    // Combine coverages from the horizontal and vertical rays using their weights.
    // Absolute values ensure that either winding direction convention works.

    var coverage = max(abs(xcov * xwgt + ycov * ywgt) / max(xwgt + ywgt, 1.0 / 65536.0), min(abs(xcov), abs(ycov)));

    // If SLUG_EVENODD is defined during compilation, then check E flag in tex.w. (See vertex shader.)

    if (SLUG_EVENODD) {
        if ((flags & 0x1000) == 0) {
            // Using nonzero fill rule here.

            coverage = saturate(coverage);
        } else {
            // Using even-odd fill rule here.

            coverage = 1.0 - abs(1.0 - fract(coverage * 0.5) * 2.0);
        }
    } else {
        // Using nonzero fill rule here.

        coverage = saturate(coverage);
    }

    // If SLUG_WEIGHT is defined during compilation, then take a square root to boost optical weight.

    if (SLUG_WEIGHT) {
        coverage = sqrt(coverage);
    }

    return coverage;
}

fn SlugRender(curveData: texture_2d<f32>, bandData: texture_2d<u32>, renderCoord: vec2<f32>, bandTransform: vec4<f32>, glyphData: vec4<i32>) -> f32 {
    var curveIndex: i32;

    // The effective pixel dimensions of the em square are computed
    // independently for x and y directions with texcoord derivatives.

    let emsPerPixel = fwidth(renderCoord);
    let pixelsPerEm = 1.0 / emsPerPixel;

    var bandMax = vec2<i32>(glyphData.z, glyphData.w & 0x00FF);

    // Determine what bands the current pixel lies in by applying a scale and offset
    // to the render coordinates. The scales are given by bandTransform.xy, and the
    // offsets are given by bandTransform.zw. Band indexes are clamped to [0, bandMax.xy].

    let bandIndex = clamp(vec2<i32>(renderCoord * bandTransform.xy + bandTransform.zw), vec2<i32>(0, 0), bandMax);
    let glyphLoc = vec2<i32>(glyphData.x, glyphData.y);

    var xcov: f32 = 0.0;
    var xwgt: f32 = 0.0;

    // Fetch data for the horizontal band from the index texture. The number
    // of curves intersecting the band is in the x component, and the offset
    // to the list of locations for those curves is in the y component.

    let hbandData = TexelLoad2D_u32(bandData, vec2<i32>(glyphLoc.x + bandIndex.y, glyphLoc.y)).xy;
    let hbandLoc = CalcBandLoc(glyphLoc, hbandData.y);

    // Loop over all curves in the horizontal band.

    for (curveIndex = 0; curveIndex < i32(hbandData.x); curveIndex++) {
        // Fetch the location of the current curve from the index texture.

        let curveLoc = vec2<i32>(TexelLoad2D_u32(bandData, vec2<i32>(hbandLoc.x + curveIndex, hbandLoc.y)).xy);

        // Fetch the three 2D control points for the current curve from the curve texture.
        // The first texel contains both p1 and p2 in the (x,y) and (z,w) components, respectively,
        // and the the second texel contains p3 in the (x,y) components. Subtracting the render
        // coordinates makes the curve relative to the sample position. The quadratic Bézier curve
        // C(t) is given by
        //
        //     C(t) = (1 - t)^2 p1 + 2t(1 - t) p2 + t^2 p3

        let p12 = TexelLoad2D_f32(curveData, curveLoc) - vec4<f32>(renderCoord, renderCoord);
        let p3 = TexelLoad2D_f32(curveData, vec2<i32>(curveLoc.x + 1, curveLoc.y)).xy - renderCoord;

        // If the largest x coordinate among all three control points falls
        // left of the current pixel, then there are no more curves in the
        // horizontal band that can influence the result, so exit the loop.
        // (The curves are sorted in descending order by max x coordinate.)

        if (max(max(p12.x, p12.z), p3.x) * pixelsPerEm.x < -0.5) {
            break;
        }

        let code = CalcRootCode(p12.y, p12.w, p3.y);
        if (code != 0u) {
            // At least one root makes a contribution. Calculate them and scale so
            // that the current pixel corresponds to the range [0,1].

            let r = SolveHorizPoly(p12, p3) * pixelsPerEm.x;

            // Bits in code tell which roots make a contribution.

            if ((code & 1u) != 0u) {
                xcov += saturate(r.x + 0.5);
                xwgt = max(xwgt, saturate(1.0 - abs(r.x) * 2.0));
            }

            if (code > 1u) {
                xcov -= saturate(r.y + 0.5);
                xwgt = max(xwgt, saturate(1.0 - abs(r.y) * 2.0));
            }
        }
    }

    var ycov: f32 = 0.0;
    var ywgt: f32 = 0.0;

    // Fetch data for the vertical band from the index texture. This follows
    // the data for all horizontal bands, so we have to add bandMax.y + 1.

    let vbandData = TexelLoad2D_u32(bandData, vec2<i32>(glyphLoc.x + bandMax.y + 1 + bandIndex.x, glyphLoc.y)).xy;
    let vbandLoc = CalcBandLoc(glyphLoc, vbandData.y);

    // Loop over all curves in the vertical band.

    for (curveIndex = 0; curveIndex < i32(vbandData.x); curveIndex++) {
        let curveLoc = vec2<i32>(TexelLoad2D_u32(bandData, vec2<i32>(vbandLoc.x + curveIndex, vbandLoc.y)).xy);
        let p12 = TexelLoad2D_f32(curveData, curveLoc) - vec4<f32>(renderCoord, renderCoord);
        let p3 = TexelLoad2D_f32(curveData, vec2<i32>(curveLoc.x + 1, curveLoc.y)).xy - renderCoord;

        // If the largest y coordinate among all three control points falls
        // below the current pixel, then there are no more curves in the
        // vertical band that can influence the result, so exit the loop.
        // (The curves are sorted in descending order by max y coordinate.)

        if (max(max(p12.y, p12.w), p3.y) * pixelsPerEm.y < -0.5) {
            break;
        }

        let code = CalcRootCode(p12.x, p12.z, p3.x);
        if (code != 0u) {
            let r = SolveVertPoly(p12, p3) * pixelsPerEm.y;

            if ((code & 1u) != 0u) {
                ycov -= saturate(r.x + 0.5);
                ywgt = max(ywgt, saturate(1.0 - abs(r.x) * 2.0));
            }

            if (code > 1u) {
                ycov += saturate(r.y + 0.5);
                ywgt = max(ywgt, saturate(1.0 - abs(r.y) * 2.0));
            }
        }
    }

    return CalcCoverage(xcov, ycov, xwgt, ywgt, glyphData.w);
}

struct VertexStruct {
    @builtin(position) position: vec4<f32>,              // Clip-space vertex position.
    @location(0) color: vec4<f32>,                       // Vertex color.
    @location(1) texcoord: vec2<f32>,                    // Em-space sample coordinates.
    @location(2) @interpolate(flat) banding: vec4<f32>,  // Band scale and offset, constant over glyph.
    @location(3) @interpolate(flat) glyph: vec4<i32>,    // (glyph data x coord, glyph data y coord, band max x, band max y and flags), constant over glyph.
};

@group(0) @binding(1) var curveTexture: texture_2d<f32>;     // Control point texture.
@group(0) @binding(2) var bandTexture: texture_2d<u32>;      // Band data texture.

@fragment
fn main(vresult: VertexStruct) -> @location(0) vec4<f32> {
    let coverage = SlugRender(curveTexture, bandTexture, vresult.texcoord, vresult.banding, vresult.glyph);
    return vresult.color * coverage;
}
