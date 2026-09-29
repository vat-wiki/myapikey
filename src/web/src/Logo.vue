<script setup lang="ts">
/** Brand mark for MyAPIKey — a key (the "API key") over a wavy line (the
 *  gateway's flow / bridge between sides). Warm sunset gradient tile + crisp
 *  white glyph: sunny/energetic, and the warm palette sets it apart from the
 *  usual cool blue/purple dev-tool marks. Reads the same on light and dark. */
withDefaults(defineProps<{ size?: number | string }>(), { size: 28 });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 40 40"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="MyAPIKey"
  >
    <defs>
      <linearGradient id="myapikey-logo" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#f59e0b" />
        <stop offset="0.33" stop-color="#f97316" />
        <stop offset="0.67" stop-color="#ef4444" />
        <stop offset="1" stop-color="#ec4899" />
      </linearGradient>
    </defs>
    <rect width="40" height="40" rx="10" fill="url(#myapikey-logo)" />
    <!-- key: bow + shaft + two teeth (upper half, vertically centered with the wave as one unit) -->
    <g stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="14" cy="16.5" r="4.6" />
      <path d="M19.6 16.5 H31.5 M26.5 16.5 V20.8 M31.5 16.5 V19.5" />
    </g>
    <!-- wavy flow / bridge line, with a small gap below the key -->
    <path
      d="M6 28 Q9.5 25 13 28 T20 28 T27 28 T34 28"
      stroke="#fff"
      stroke-width="2.8"
      stroke-linecap="round"
      opacity="0.9"
    />
  </svg>
</template>
