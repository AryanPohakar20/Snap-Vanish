export const QUAD_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const COMPOSITE_FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_source;
uniform sampler2D u_background;
uniform sampler2D u_mask;
uniform float u_dissolve;
uniform float u_seed;
uniform vec3 u_glowColor;
uniform float u_glowStrength;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7)) + u_seed * 13.7) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 sourceColor = texture2D(u_source, uv);
  vec4 backgroundColor = texture2D(u_background, uv);
  float mask = texture2D(u_mask, uv).r;

  float noise = valueNoise(uv * vec2(170.0, 110.0));
  noise = clamp(noise * 0.72 + hash(uv * 731.0) * 0.28, 0.0, 1.0);

  float threshold = u_dissolve * 0.94;
  threshold += smoothstep(0.78, 1.0, u_dissolve) * 0.22;
  float value = 1.0 - noise;
  float keep = smoothstep(threshold - 0.085, threshold + 0.085, value);

  keep *= 1.0 - smoothstep(0.97, 0.995, u_dissolve);

  float edge = smoothstep(threshold - 0.13, threshold - 0.01, value) *
               (1.0 - smoothstep(threshold - 0.01, threshold + 0.045, value));
  edge *= smoothstep(0.02, 0.25, u_dissolve) * (1.0 - smoothstep(0.82, 1.0, u_dissolve));

  float personAlpha = clamp(mask * keep, 0.0, 1.0);
  personAlpha *= 1.0 - smoothstep(0.995, 1.0, u_dissolve);
  vec3 color = mix(backgroundColor.rgb, sourceColor.rgb, personAlpha);
  color += u_glowColor * edge * mask * u_glowStrength;

  float vignette = 1.0 - 0.16 * length(uv - 0.5);
  color *= vignette;

  gl_FragColor = vec4(color, 1.0);
}
`;

export const PARTICLE_VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec3 a_color;
attribute float a_seed;
attribute float a_size;
attribute float a_delay;
attribute vec2 a_direction;

uniform float u_dissolve;
uniform float u_pixelScale;
uniform vec3 u_glowColor;

varying vec3 v_color;
varying float v_alpha;

void main() {
  float stagger = a_delay * 0.38;
  float local = clamp((u_dissolve - stagger) / max(0.05, 1.0 - stagger), 0.0, 1.0);
  local = local * local * (3.0 - 2.0 * local);

  vec2 turbulence = vec2(
    sin(a_seed * 91.7 + local * 13.0),
    cos(a_seed * 57.3 + local * 9.0)
  ) * 0.016 * local;

  vec2 offset = a_direction * 0.24 * pow(local, 1.22) + turbulence;
  vec2 position = a_position + offset;

  gl_Position = vec4(position.x * 2.0 - 1.0, (1.0 - position.y) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = a_size * u_pixelScale * (0.7 + local * 1.15);

  float fadeIn = smoothstep(0.0, 0.12, local);
  float fadeOut = 1.0 - smoothstep(0.68, 0.96, local);
  float flicker = 0.45 + 0.55 * abs(sin(a_seed * 31.7 + local * 7.0));
  v_alpha = fadeIn * fadeOut * flicker * (1.0 - smoothstep(0.98, 1.0, local));
  v_color = mix(a_color, u_glowColor, 0.34 + 0.3 * local);
}
`;

export const PARTICLE_FRAGMENT_SHADER = `
precision mediump float;
varying vec3 v_color;
varying float v_alpha;

void main() {
  vec2 center = gl_PointCoord - vec2(0.5);
  float distanceToCenter = length(center);
  float core = smoothstep(0.5, 0.06, distanceToCenter);
  float glow = smoothstep(0.5, 0.0, distanceToCenter);
  float alpha = core * v_alpha;
  vec3 color = v_color + vec3(0.32, 0.2, 0.06) * glow * v_alpha;
  gl_FragColor = vec4(color, alpha * 0.9);
}
`;
