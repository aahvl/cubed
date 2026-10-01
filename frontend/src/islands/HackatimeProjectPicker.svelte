<script>
  // Persistent selection (name -> {name, start, end, text}), shown as cards
  // with their own remove (×) button — independent of the picker dialog,
  // which is only for adding more. Each entry keeps the date range it was
  // added under, so reopening the dialog with a different range and adding
  // more doesn't retroactively change already-picked entries' dates — the
  // real Airtable field's own spec allows differing ranges per project,
  // this now actually supports that instead of forcing one shared range.
  import { apiFetch } from "../lib/api-client";

  // `initialFormatted` is the project's already-saved value (if any) —
  // parsed back into cards on mount so reopening a draft shows what was
  // already picked, not an empty list. Hours/minutes aren't recoverable
  // from the saved string alone, so restored cards show their date range
  // instead of an hours total (only freshly-loaded entries have that).
  let { onSelectionChange, initialFormatted = "" } = $props();

  // Fixed, not user-chosen — start of this month through Dec 31 of this
  // year, always. No date inputs in the UI at all.
  const startDate = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;
  const endDate = `${new Date().getFullYear()}-12-31`;

  // M/D/YYYY, no leading zeros — matches the field's own example format
  // ("7/20/2026-7/22/2026"), not the <input type="date"> ISO value.
  function formatDate(isoDate) {
    const [y, m, d] = isoDate.split("-");
    return `${Number(m)}/${Number(d)}/${y}`;
  }

  function usDateToIso(usDate) {
    const [m, d, y] = usDate.split("/");
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // Reverses formatDate()'s "name M/D/YYYY-M/D/YYYY" — name itself may
  // contain spaces/dashes, so the date-range suffix is matched from the
  // right rather than split naively on the first space.
  function parseFormatted(str) {
    /** @type {Record<string, {name: string, start: string, end: string, text: string}>} */
    const result = {};
    for (const part of str.split(",").map((s) => s.trim()).filter(Boolean)) {
      const match = part.match(/^(.*)\s+(\d{1,2}\/\d{1,2}\/\d{4})-(\d{1,2}\/\d{1,2}\/\d{4})$/);
      if (!match) continue;
      const [, name, startStr, endStr] = match;
      result[name] = { name, start: usDateToIso(startStr), end: usDateToIso(endStr), text: `${startStr}-${endStr}` };
    }
    return result;
  }

  let dialogOpen = $state(false);
  let loading = $state(false);
  let error = $state("");
  let loadedProjects = $state(/** @type {{name: string, hours: number, minutes: number, text: string}[]} */ ([]));
  let hasLoaded = $state(false);
  let hackatimeUserId = $state("");

  /** @type {Record<string, {name: string, start: string, end: string, text: string}>} */
  let selected = $state(parseFormatted(initialFormatted));

  function notify() {
    const entries = Object.values(selected);
    const formatted = entries.map((e) => `${e.name} ${formatDate(e.start)}-${formatDate(e.end)}`).join(", ");
    onSelectionChange?.({ formatted, hackatimeUserId: entries.length > 0 ? hackatimeUserId : "" });
  }

  async function loadProjects() {
    loading = true;
    error = "";
    try {
      const res = await apiFetch(`/me/hackatime-projects?start=${startDate}&end=${endDate}`);
      if (!res.ok) throw new Error("Couldn't load your Hackatime projects. Try again in a moment.");
      const body = await res.json();
      loadedProjects = body.projects ?? [];
      hackatimeUserId = body.hackatimeUserId || hackatimeUserId;
      hasLoaded = true;
      if (loadedProjects.length === 0) {
        error = "No Hackatime activity found in that date range.";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : "Something went wrong.";
      loadedProjects = [];
      hasLoaded = false;
    } finally {
      loading = false;
    }
  }

  function toggle(project) {
    if (project.name in selected) {
      const { [project.name]: _removed, ...rest } = selected;
      selected = rest;
    } else {
      selected = { ...selected, [project.name]: { name: project.name, start: startDate, end: endDate, text: project.text } };
    }
    notify();
  }

  function removeEntry(name) {
    const { [name]: _removed, ...rest } = selected;
    selected = rest;
    notify();
  }

  // Opening the dialog IS the "go fetch it" action — no separate load
  // button inside it, that'd just be a redundant extra click on top of the
  // popup that already just opened.
  function openDialog() {
    dialogOpen = true;
    loadProjects();
  }
  function closeDialog() {
    dialogOpen = false;
  }
</script>

<div class="flex flex-col gap-2">
  {#if Object.keys(selected).length > 0}
    <div class="flex flex-col gap-2">
      {#each Object.values(selected) as entry (entry.name)}
        <div class="flex items-center justify-between gap-3 rounded-none border-2 border-[#5c4429]/20 bg-white px-3 py-2">
          <span class="text-sm font-bold">{entry.name}</span>
          <span class="flex items-center gap-3">
            <span class="text-xs text-black/50">{entry.text}</span>
            <button
              type="button"
              onclick={() => removeEntry(entry.name)}
              aria-label={`Remove ${entry.name}`}
              class="cursor-pointer text-lg leading-none text-black/40 hover:text-app-orange"
            >
              &times;
            </button>
          </span>
        </div>
      {/each}
    </div>
  {/if}

  <button
    type="button"
    onclick={openDialog}
    class="w-fit cursor-pointer rounded-none border-2 border-[#5c4429] bg-white px-4 py-2 text-xs font-bold uppercase tracking-wide hover:bg-app-mint/30"
  >
    Select Hackatime projects
  </button>
</div>

{#if dialogOpen}
  <!-- Own lightweight overlay (not PopupShell) — same pattern as
       ConfirmDialog.svelte, so it layers on top of the already-open
       Projects popup instead of replacing it. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onclick={closeDialog}>
    <div
      class="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-none border-[6px] border-[#5c4429] bg-[#cfe0d5] p-6"
      onclick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onclick={closeDialog}
        aria-label="Close"
        class="absolute right-3 top-3 grid h-8 w-8 cursor-pointer place-items-center rounded-none border-2 border-[#5c4429] bg-white text-lg font-bold leading-none hover:bg-black/5"
      >
        &times;
      </button>
      <h3 class="mb-4 pr-8 text-lg font-bold text-[#2e4a3d]">Select Hackatime projects</h3>

      <div class="flex flex-col gap-2">
        {#if loading}
          <p class="text-sm text-black/50">Loading your Hackatime projects...</p>
        {/if}

        {#if error}
          <p class="text-xs text-app-orange">{error}</p>
        {/if}

        {#if hasLoaded && loadedProjects.length > 0}
          <div class="flex flex-col gap-2 rounded-none border-2 border-[#5c4429]/30 bg-white/60 p-3">
            {#each loadedProjects as project (project.name)}
              <label class="flex cursor-pointer items-center justify-between gap-3 rounded-none border-2 border-[#5c4429]/20 bg-white px-3 py-2 hover:border-[#5c4429]">
                <span class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={project.name in selected}
                    onchange={() => toggle(project)}
                    class="h-4 w-4 shrink-0 accent-[#5c4429]"
                  />
                  <span class="text-sm font-bold">{project.name}</span>
                </span>
                <span class="text-xs text-black/50">{project.text}</span>
              </label>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
