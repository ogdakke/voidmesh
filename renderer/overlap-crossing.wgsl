// Contact-space effects shared by image, SVG/GIF textures, and external video.
struct Contact {
  rect: vec4f, // Other card center and half size in world coordinates.
  pose: vec4f, // cos, sin, participant key, role (+lifted / -cover).
  metric: vec4f, // world units per CSS pixel, crossing depth, partner key, shared contact span.
  axis: vec4f, // Separation direction away from other card; shared contact center.
}
struct Contacts {
  header: vec4f, // count, treatment, decay progress, strength
  timeline: vec4f, // continuous lift depth, direction, event progress, decay seconds
  items: array<Contact>,
}
@group(1) @binding(0) var<storage, read> contacts: Contacts;

fn crossingGrid(index: u32) -> vec2f {
  let corners = array<vec2f, 6>(vec2f(0,0), vec2f(1,0), vec2f(0,1), vec2f(1,0), vec2f(1,1), vec2f(0,1));
  if (contacts.header.x == 0.0 || contacts.header.y != 5.0) { return corners[index]; }
  let cell = index / 6u;
  return (vec2f(f32(cell % 16u), f32(cell / 16u)) + corners[index % 6u]) / 16.0;
}
fn contactDistance(local: vec2f, halfSize: vec2f) -> f32 {
  let q = abs(local) - halfSize;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}
fn contactNormal(local: vec2f, halfSize: vec2f) -> vec2f {
  let q = abs(local) - halfSize;
  let signXY = select(vec2f(-1.0), vec2f(1.0), local >= vec2f(0.0));
  if (q.x > 0.0 && q.y > 0.0) { return normalize(q) * signXY; }
  return select(vec2f(0.0, signXY.y), vec2f(signXY.x, 0.0), q.x > q.y);
}
fn contactRotate(v: vec2f, pose: vec2f) -> vec2f {
  return vec2f(v.x * pose.x - v.y * pose.y, v.x * pose.y + v.y * pose.x);
}
fn contactLocal(v: vec2f, pose: vec2f) -> vec2f {
  return vec2f(dot(v, pose), dot(v, vec2f(-pose.y, pose.x)));
}
struct ContactField {
  coverage: f32,
  passing: f32,
  role: f32,
  pixel: f32,
  distance: f32,
  normal: vec2f,
  away: vec2f,
}
// Select the strongest nearby contact. Deep stacks cannot amplify without bound.
fn crossingField(world: vec2f, key: u32) -> ContactField {
  var result: ContactField;
  var best = -1.0;
  let lift = contacts.timeline.x;
  for (var i = 0u; i < u32(contacts.header.x); i++) {
    let contact = contacts.items[i];
    if (u32(contact.pose.z) != key) { continue; }
    let local = contactLocal(world - contact.rect.xy, contact.pose.xy);
    let sd = contactDistance(local, contact.rect.zw);
    let pixel = contact.metric.x;
    let zWindow = 1.0 - smoothstep(0.02, 0.38, abs(lift - contact.metric.y));
    // Ported from the supplied Yield study: passing peaks between resting layers.
    let passing = 4.0 * lift * (1.0 - lift) * max(zWindow, 0.4);
    let score = exp(-max(sd, 0.0) / max(120.0 * pixel, 1.0)) * (0.1 + passing);
    if (score <= best) { continue; }
    best = score;
    result.coverage = 1.0 - smoothstep(-24.0 * pixel, 24.0 * pixel, sd);
    result.passing = passing;
    result.role = contact.pose.w;
    result.pixel = pixel;
    result.distance = sd;
    result.normal = contactRotate(contactNormal(local, contact.rect.zw), contact.pose.xy);
    result.away = contact.axis.xy;
  }
  return result;
}
// Preserve diffusion's existing pulse and lingering diffusion radius.
fn crossingEnvelope() -> f32 {
  let t = contacts.header.z;
  let crossing = contacts.timeline.z;
  let pulse = sin(crossing * 3.14159265) * 0.7 + smoothstep(0.0, 0.4, crossing) * 0.3;
  return pulse * pow(1.0 - t, 2.0) * contacts.header.w;
}
fn contactEcho() -> f32 {
  return smoothstep(0.2, 0.75, contacts.timeline.z) * pow(1.0 - contacts.header.z, 2.0);
}
fn peelAngle(uv: vec2f, size: vec2f, pose: vec2f, field: ContactField) -> f32 {
  let axis = contactLocal(field.away, pose);
  let halfExtent = max(dot(abs(axis), size * 0.5), 1.0);
  let along = dot((uv - 0.5) * size, axis);
  // The edge facing the obstruction curls; the far edge remains anchored.
  let hinge = clamp((halfExtent - along) / (2.0 * halfExtent), 0.0, 1.0);
  return hinge * hinge * field.coverage * field.passing * min(contacts.header.w, 1.6) * 0.65;
}
fn crossingBend(world: vec2f, key: u32, uv: vec2f, size: vec2f, rotation: f32) -> vec2f {
  if (contacts.header.y != 5.0 || contacts.header.x == 0.0) { return world; }
  let field = crossingField(world, key);
  let pose = vec2f(cos(rotation), sin(rotation));
  let axis = contactLocal(field.away, pose);
  let halfExtent = max(dot(abs(axis), size * 0.5), 1.0);
  let arm = max(0.0, halfExtent - dot((uv - 0.5) * size, axis));
  let angle = peelAngle(uv, size, pose, field);
  let shortening = arm * (1.0 - cos(angle));
  let height = arm * sin(angle) * field.role;
  // Opposing signed heights open a gap between the sheets. Project the bent
  // surface with perspective around its hinge, keeping the far edge anchored.
  let focalLength = max(max(size.x, size.y) * 3.0, 1.0);
  let perspective = focalLength / (focalLength - height);
  let hinge = world + field.away * arm;
  let bent = world + field.away * shortening;
  return hinge + (bent - hinge) * perspective + vec2f(0.0, -0.32 * height);
}
struct CrossingPaint {
  selected: u32,
  debug: u32,
  border: vec2f,
}
fn crossingSample(uv: vec2f, paint: CrossingPaint) -> vec4f {
  let outside = any(uv < vec2f(0.0)) || any(uv > vec2f(1.0));
  if (paint.selected == 1u && outside && all(uv >= -paint.border) && all(uv <= vec2f(1.0) + paint.border)) {
    let blue = vec3f(59.0 / 255.0, 130.0 / 255.0, 246.0 / 255.0);
    return vec4f(select(blue, vec3f(1.0, 0.0, 0.0), paint.debug == 1u), 1.0);
  }
  let color = textureSample(entityTexture, entitySampler, clamp(uv, vec2f(0.0), vec2f(1.0)));
  return color * select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)));
}
fn crossingPremultiplied(uv: vec2f, paint: CrossingPaint) -> vec4f {
  let color = crossingSample(uv, paint);
  return vec4f(color.rgb * color.a, color.a);
}
fn crossingMaterial(uv: vec2f, world: vec2f, key: u32, size: vec2f, pose: vec2f, paint: CrossingPaint) -> vec4f {
  if (contacts.header.x == 0.0) { return crossingSample(uv, paint); }
  let field = crossingField(world, key);
  if (field.pixel == 0.0) { return crossingSample(uv, paint); }
  let mode = u32(contacts.header.y);
  let pixel = vec2f(field.pixel) / max(size, vec2f(1.0));
  let local = (uv - 0.5) * size;
  let ownDistance = contactDistance(local, size * 0.5);
  let seamDistance = max(ownDistance, field.distance);
  let worldNormal = select(field.normal, contactRotate(contactNormal(local, size * 0.5), pose), ownDistance > field.distance);
  let normal = contactLocal(worldNormal, pose);
  let strength = contacts.header.w;
  let echo = contactEcho();

  if (mode == 1u) {
    if (field.passing < 0.00001) { return crossingSample(uv, paint); }
    // Yield port: inverse radial displacement, tangential curl and edge recession
    // in the intersection, scaled from the study's 0.372 x 0.52 world-unit cards.
    let unit = min(size.x / 0.372, size.y / 0.52);
    let vesica = (1.0 - smoothstep(-0.01 * unit, 0.02 * unit, seamDistance)) * field.passing * strength;
    // Regularize the reference's radial normalization at the center: a constant
    // inward displacement there folds the image over itself into a ring.
    let radial = min(0.6, vesica * 0.07 * unit / sqrt(dot(local, local) + pow(0.12 * unit, 2.0)));
    var warped = local * (1.0 + radial * field.role);
    warped.x += sin(warped.y / unit * 9.0) * vesica * 0.018 * unit;
    let color = crossingSample(warped / size + 0.5, paint);
    let edge = ownDistance + vesica * 0.02 * unit;
    let aa = max(fwidth(ownDistance), 0.5 * field.pixel);
    let alpha = 1.0 - smoothstep(-aa, aa, edge);
    let curlShade = 1.0 - vesica * 0.12 + exp(-abs(seamDistance) / max(3.0 * field.pixel, 0.001)) * vesica * 0.08;
    return vec4f(color.rgb * curlShade, color.a * alpha);
  }
  if (mode == 2u) {
    let amount = field.coverage * crossingEnvelope();
    let t = contacts.header.z + contacts.timeline.z * 0.3;
    let theta = t * 7.0 + sin(uv.x * 31.0 + uv.y * 23.0);
    let axis = vec2f(cos(theta), sin(theta)) * pixel * 22.0 * amount;
    let cross = vec2f(-axis.y, axis.x);
    let diffused = crossingPremultiplied(uv, paint) * 0.28 + (crossingPremultiplied(uv + axis, paint) + crossingPremultiplied(uv - axis, paint) + crossingPremultiplied(uv + cross, paint) + crossingPremultiplied(uv - cross, paint)) * 0.18;
    return vec4f(diffused.rgb / max(diffused.a, 0.001), diffused.a);
  }
  if (mode == 3u) {
    // Prism: a glass wedge at the shared edge, not a whole-image oscillation.
    let d = seamDistance / field.pixel;
    let band = exp(-d * d / (2.0 * 18.0 * 18.0));
    let energy = (field.passing + 0.22 * echo) * band * strength;
    let bend = normal * pixel * energy * 5.0 * field.role;
    let split = normal * pixel * energy * 7.0;
    let base = crossingSample(uv + bend, paint);
    let red = crossingSample(uv + bend + split, paint);
    let blue = crossingSample(uv + bend - split, paint);
    let rgb = vec3f(red.r * red.a, base.g * base.a, blue.b * blue.a) / max(base.a, 0.001);
    return vec4f(rgb, base.a);
  }
  if (mode == 4u) {
    // Wake: one damped wave launched from the other card's edge. Its direction
    // comes from the rotated contact geometry, not the center of either image.
    let age = contacts.timeline.z * 0.25 + contacts.header.z;
    let radius = 6.0 + age * 96.0;
    let d = abs(field.distance / field.pixel) - radius;
    let packet = exp(-d * d / (2.0 * 14.0 * 14.0)) * sin(d / 9.0);
    let amplitude = smoothstep(0.0, 0.2, contacts.timeline.z) * pow(1.0 - contacts.header.z, 2.0) * strength;
    let direction = contactLocal(field.normal, pose);
    let warp = direction * pixel * packet * amplitude * 9.0 * contacts.timeline.y;
    return crossingSample(uv + warp, paint);
  }
  if (mode == 5u) {
    let color = crossingSample(uv, paint);
    let angle = peelAngle(uv, size, pose, field);
    // Broad paper shading follows the same bend as the actual mesh.
    let shade = 0.72 + 0.28 * cos(angle) - 0.12 * sin(angle);
    return vec4f(color.rgb * shade, color.a);
  }
  return crossingSample(uv, paint);
}

// Cross-fade the two possible occlusion orders at their shared depth. Only the
// currently front card becomes transmissive; the rear card stays solid. At the
// sorting boundary both orders produce 50% of each image, rather than a snap
// or two half-transparent cards exposing a hole through to the canvas.
fn crossingTransmission(world: vec2f, key: u32) -> f32 {
  var transmission = 1.0;
  for (var i = 0u; i < u32(contacts.header.x); i++) {
    let contact = contacts.items[i];
    if (u32(contact.pose.z) != key) { continue; }
    let depth = contacts.timeline.x - contact.metric.y;
    let front = select((depth < 0.0), (depth >= 0.0), (contact.pose.w > 0.0));
    if (!front) { continue; }
    var partnerWorld = world;
    if (contacts.header.y == 5.0) {
      // Invert the partner's projected sheet so curling open an actual gap does
      // not make the remaining card transparent over empty canvas.
      let size = contact.rect.zw * 2.0;
      let rotation = atan2(contact.pose.y, contact.pose.x);
      for (var step = 0u; step < 7u; step++) {
        let uv = contactLocal(partnerWorld - contact.rect.xy, contact.pose.xy) / size + 0.5;
        partnerWorld += world - crossingBend(partnerWorld, u32(contact.metric.z), uv, size, rotation);
      }
    }
    let local = contactLocal(partnerWorld - contact.rect.xy, contact.pose.xy);
    let sd = contactDistance(local, contact.rect.zw);
    let coverage = 1.0 - smoothstep(-contact.metric.x, contact.metric.x, sd);
    let mode = u32(contacts.header.y);
    let lift = contacts.timeline.x;
    let activity = 4.0 * lift * (1.0 - lift);
    // Shared coordinates are identical on both participants. Each material
    // advances its own crossing front without a discontinuity when draws swap.
    let along = dot(world - contact.axis.zw, contact.axis.xy * contact.pose.w) / contact.metric.w;
    let across = dot(world - contact.axis.zw, vec2f(-contact.axis.y, contact.axis.x) * contact.pose.w) / contact.metric.w;
    var travel = depth;
    var softness = 0.18;
    if (mode == 1u) {
      // Yield recedes around a rounded opening under pressure.
      travel += (0.3 - length(vec2f(along, across))) * activity * 0.22;
      softness = 0.12;
    } else if (mode == 3u) {
      // A tilted refractive plane sweeps across the intersection.
      travel += along * activity * 0.28;
      softness = 0.14;
    } else if (mode == 4u) {
      // The moving wave carries a curved front through the card's body.
      travel += (along + 0.12 * sin(across * 8.0 - lift * 6.0)) * activity * 0.3;
      softness = 0.1;
    } else if (mode == 5u) {
      // A narrow reveal follows the curl's height, from contact edge to hinge.
      let curl = clamp(0.5 - along, 0.0, 1.0);
      travel += (curl * curl - 0.35) * activity * 0.35;
      softness = 0.07;
    }
    let width = min(softness, min(contact.metric.y, 1.0 - contact.metric.y) * 0.8);
    let passage = smoothstep(-width, width, travel);
    let opacity = select(1.0 - passage, passage, contact.pose.w > 0.0);
    transmission *= mix(1.0, opacity, coverage);
  }
  return transmission;
}
fn crossingColor(uv: vec2f, world: vec2f, key: u32, size: vec2f, pose: vec2f, projectedWorld: vec2f, paint: CrossingPaint) -> vec4f {
  let color = crossingMaterial(uv, world, key, size, pose, paint);
  return vec4f(color.rgb, color.a * crossingTransmission(projectedWorld, key));
}
