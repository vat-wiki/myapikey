<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { req } from "./api";

interface LogEntry {
  ts: number;
  model: string;
  provider: string;
  format: string;
  status: number;
  bytesOut: number;
}

const logs = ref<LogEntry[]>([]);
let timer: number | undefined;

async function load() {
  try {
    const r = await req<{ logs: LogEntry[] }>("GET", "/admin/logs");
    logs.value = r.logs;
  } catch {
    /* ignore */
  }
}

function statusClass(s: number) {
  if (s >= 500) return "pill-off";
  if (s >= 400) return "error";
  if (s >= 200 && s < 300) return "pill-ok";
  return "muted";
}

onMounted(() => {
  load();
  timer = window.setInterval(load, 4000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="card">
    <h3 style="margin-top: 0">Recent calls</h3>
    <p class="muted" style="margin-top: -6px">In-memory, last 200, refreshed every 4s.</p>
    <p v-if="!logs.length" class="muted">No calls yet.</p>
    <table v-else>
      <thead>
        <tr><th>Time</th><th>Model</th><th>Provider</th><th>Format</th><th>Status</th></tr>
      </thead>
      <tbody>
        <tr v-for="(l, i) in logs" :key="i">
          <td class="monos muted">{{ new Date(l.ts).toLocaleTimeString() }}</td>
          <td class="monos">{{ l.model }}</td>
          <td>{{ l.provider }}</td>
          <td><span class="tag">{{ l.format }}</span></td>
          <td :class="statusClass(l.status)" class="monos">{{ l.status }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
