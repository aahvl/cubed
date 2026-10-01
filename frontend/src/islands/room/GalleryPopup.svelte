<script>
  // `projects` is prefetched server-side (GET /gallery, already excludes
  // rejected projects and every status/search/sort filter below is plain
  // client-side filtering over that one array — no pagination on that
  // endpoint). Selecting a card adds `?gallery=<id>` (or `?userId=<id>` for
  // the "view this user's projects" mode below) so it's a shareable link.
  import { apiFetch } from "../../lib/api-client";
  import PopupShell from "./PopupShell.svelte";

  let {
    projects,
    onClose,
    initialProjectId = null,
    onProjectSelected,
    isAdmin = false,
    initialViewUserId = null,
    onViewUserChanged,
  } = $props();

  // Local mutable copy so an upvote updates in place without a re-fetch.
  let items = $state(projects.map((p) => ({ ...p })));

  let query = $state("");
  let statusFilter = $state("all");
  let sortBy = $state("recent");
  let selectedId = $state(initialProjectId);

  // "View all of this user's projects" (opened by clicking a submitter's
  // pfp in the detail view). `items` already holds every non-rejected
  // project across every user (the gallery endpoint isn't paginated), so
  // this is a local filter, not a fresh fetch — works instantly and also
  // survives a cold page-load straight into `?userId=`.
  let viewingUserId = $state(initialViewUserId);
  let userProjects = $derived(items.filter((p) => p.userId === viewingUserId));
  // Null if that user currently has zero visible projects (e.g. a stale/
  // shared link) — the one case where we can't show their nickname/avatar.
  let viewingUserInfo = $derived(userProjects[0] ?? null);

  function viewUser(project) {
    viewingUserId = project.userId;
    onViewUserChanged?.(project.userId);
    select(null);
  }

  const STATUS_OPTIONS = [
    { value: "all", label: "All" },
    { value: "draft", label: "Draft" },
    { value: "submitted", label: "Submitted" },
    { value: "approved", label: "Approved" },
  ];

  const SORT_OPTIONS = [
    { value: "recent", label: "Newest" },
    { value: "upvotes", label: "Most upvoted" },
  ];

  function statusColor(status) {
    switch (status) {
      case "approved":
        return "bg-app-mint";
      case "rejected":
        return "bg-app-orange";
      case "submitted":
        return "bg-app-lavender";
      default:
        return "bg-white";
    }
  }

  function select(id) {
    selectedId = id;
    onProjectSelected?.(id);
    if (id) {
      const project = items.find((p) => p.id === id);
      if (project) {
        project.viewCount += 1;
        apiFetch(`/gallery/${id}/view`, { method: "POST" }).catch(() => {});
      }
    }
  }

  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const result = items.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
    if (sortBy === "upvotes") {
      result.sort((a, b) => b.upvoteCount - a.upvoteCount);
    }
    return result;
  });

  let selected = $derived(items.find((p) => p.id === selectedId) ?? null);

  let upvoting = $state(false);
  async function toggleUpvote(project) {
    if (upvoting) return;
    upvoting = true;
    const wasUpvoted = project.viewerHasUpvoted;
    // reverted in the catch block if the request fails.
    project.viewerHasUpvoted = !wasUpvoted;
    project.upvoteCount += wasUpvoted ? -1 : 1;
    try {
      const res = await apiFetch(`/gallery/${project.id}/upvote`, { method: "POST" });
      if (!res.ok) throw new Error();
      const body = await res.json();
      project.viewerHasUpvoted = body.upvoted;
      project.upvoteCount = body.upvoteCount;
    } catch {
      project.viewerHasUpvoted = wasUpvoted;
      project.upvoteCount += wasUpvoted ? 1 : -1;
    } finally {
      upvoting = false;
    }
  }
</script>

<PopupShell
  title="Gallery"
  subtitle={selected || viewingUserId ? "" : "See what everyone's building. Upvote a project to show support."}
  maxWidth="max-w-5xl"
  onClose={() => {
    if (selected) {
      select(null);
    } else if (viewingUserId) {
      viewingUserId = null;
      onViewUserChanged?.(null);
    } else {
      onClose();
    }
  }}
>
  {#snippet children()}
    {#snippet projectCard(project)}
      <div class="group relative flex flex-col overflow-hidden rounded-none border-2 border-[#5c4429]/30 bg-[#e4ecdf] transition-all hover:-translate-y-1 hover:border-[#5c4429]">
        <button
          type="button"
          onclick={() => select(project.id)}
          aria-label={`View ${project.name}`}
          data-no-hover-scale
          class="absolute inset-0 z-0 cursor-pointer"
        ></button>
        <div class="pointer-events-none relative z-[1] flex flex-1 flex-col">
          {#if project.photoUrl}
            <div class="relative">
              <img src={project.photoUrl} alt="" class="h-20 w-full border-b-2 border-[#5c4429]/30 object-cover" />
              <span class="absolute bottom-1 right-1 flex items-center gap-1 rounded-none bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">
                <svg viewBox="0 0 24 24" class="h-3 w-3 fill-none stroke-current" stroke-width="2.5"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                {project.viewCount}
              </span>
            </div>
          {/if}
          <div class="flex flex-1 flex-col gap-1 p-3">
            <span class={`w-fit rounded-none border border-[#5c4429]/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusColor(project.status)}`}>
              {project.status}
            </span>
            <h3 class="line-clamp-1 text-sm font-bold">{project.name}</h3>
            <p class="line-clamp-2 flex-1 text-xs text-black/60">{project.description}</p>
            <div class="mt-1 flex items-center justify-between gap-2">
              <p class="line-clamp-1 text-[11px] text-black/50">by {project.nickname}</p>
              <button
                type="button"
                onclick={() => toggleUpvote(project)}
                class={`pointer-events-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-none border border-[#5c4429]/40 px-1.5 py-0.5 text-[11px] font-bold transition-all ${project.viewerHasUpvoted ? "bg-app-gold" : "bg-white hover:bg-app-gold/30"}`}
              >
                <span>&#9650;</span>
                <span>{project.upvoteCount}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    {/snippet}

    {#if selected}
      <div class="flex flex-col gap-4">
        {#if selected.photoUrl}
          <img
            src={selected.photoUrl}
            alt={`Screenshot of ${selected.name}`}
            class="h-56 w-full rounded-none border-2 border-[#5c4429]/40 object-cover sm:h-72"
          />
        {/if}
        <div class="flex flex-wrap items-start justify-between gap-3">
          <h3 class="text-2xl font-bold">{selected.name}</h3>
          <span class={`shrink-0 rounded-none border-2 border-[#5c4429]/40 px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${statusColor(selected.status)}`}>
            {selected.status}
          </span>
        </div>
        <p class="whitespace-pre-wrap text-black/80">{selected.description}</p>
        <div class="flex flex-wrap gap-4 text-sm">
          {#if selected.repoUrl}
            <a href={selected.repoUrl} target="_blank" rel="noreferrer" class="flex items-center gap-1.5 font-bold text-app-lavender underline">
              <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 fill-current"><path d="M12 2C6.48 2 2 6.58 2 12.17c0 4.48 2.87 8.28 6.84 9.62.5.1.68-.22.68-.49 0-.24-.01-1.04-.01-1.89-2.78.61-3.37-1.21-3.37-1.21-.46-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.05 1.53 1.05.89 1.55 2.34 1.1 2.91.84.09-.66.35-1.1.63-1.36-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.72 0 0 .84-.27 2.75 1.05a9.3 9.3 0 0 1 5 0c1.91-1.32 2.75-1.05 2.75-1.05.55 1.41.2 2.46.1 2.72.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.81 0 .27.18.6.69.49A10.02 10.02 0 0 0 22 12.17C22 6.58 17.52 2 12 2Z" /></svg>
              View code
            </a>
          {/if}
          {#if selected.demoUrl}
            <a href={selected.demoUrl} target="_blank" rel="noreferrer" class="flex items-center gap-1.5 font-bold text-app-lavender underline">
              <svg viewBox="0 0 24 24" class="h-4 w-4 shrink-0 fill-none stroke-current" stroke-width="2"><path d="M14 3h7v7" /><path d="M10 14 21 3" /><path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6" /></svg>
              View demo
            </a>
          {/if}
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3 border-t-2 border-[#5c4429]/20 pt-4">
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onclick={() => viewUser(selected)}
              aria-label={`View all of ${selected.nickname}'s projects`}
              class="group flex cursor-pointer items-center gap-2"
            >
              {#if selected.avatarUrl}
                <img src={selected.avatarUrl} alt="" class="h-8 w-8 shrink-0 rounded-full border-2 border-[#5c4429]/40 object-cover transition-transform group-hover:scale-105" />
              {:else}
                <div class="grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 border-[#5c4429]/40 bg-white text-xs font-bold transition-transform group-hover:scale-105">
                  {(selected.nickname ?? "?").trim().charAt(0).toUpperCase() || "?"}
                </div>
              {/if}
              <p class="text-sm text-black/60 underline decoration-dotted underline-offset-2 group-hover:text-black">by {selected.nickname}</p>
            </button>
            {#if isAdmin && selected.slackId}
              <span class="rounded-none border border-[#5c4429]/30 bg-white px-1.5 py-0.5 font-mono text-[11px] text-black/50">Slack: {selected.slackId}</span>
            {/if}
            <span class="flex items-center gap-1 text-sm text-black/50">
              <svg viewBox="0 0 24 24" class="h-4 w-4 fill-none stroke-current" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" /><circle cx="12" cy="12" r="3" /></svg>
              {selected.viewCount}
            </span>
          </div>
          <button
            type="button"
            onclick={() => toggleUpvote(selected)}
            class={`flex cursor-pointer items-center gap-2 rounded-none border-2 border-[#5c4429] px-4 py-2 text-sm font-bold transition-all ${selected.viewerHasUpvoted ? "bg-app-gold text-black" : "bg-white hover:bg-app-gold/30"}`}
          >
            <span>&#9650;</span>
            <span>{selected.upvoteCount}</span>
          </button>
        </div>
      </div>
    {:else if viewingUserId}
      <div class="mb-4 flex items-center gap-3 border-b-2 border-[#5c4429]/20 pb-4">
        {#if viewingUserInfo?.avatarUrl}
          <img src={viewingUserInfo.avatarUrl} alt="" class="h-10 w-10 shrink-0 rounded-full border-2 border-[#5c4429]/40 object-cover" />
        {:else}
          <div class="grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 border-[#5c4429]/40 bg-white text-sm font-bold">
            {(viewingUserInfo?.nickname ?? "?").trim().charAt(0).toUpperCase() || "?"}
          </div>
        {/if}
        <h3 class="text-xl font-bold">
          {viewingUserInfo ? `${viewingUserInfo.nickname}'s projects` : "No public projects"}
        </h3>
      </div>

      {#if userProjects.length === 0}
        <p class="text-black/60">This user doesn't have any public projects yet.</p>
      {:else}
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {#each userProjects as project (project.id)}
            {@render projectCard(project)}
          {/each}
        </div>
      {/if}
    {:else}
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          bind:value={query}
          placeholder="Search by name..."
          class="min-w-0 flex-1 rounded-none border-2 border-[#5c4429]/40 bg-white px-3 py-2 text-sm outline-none focus:border-[#5c4429]"
        />
        <div class="flex flex-wrap gap-1.5">
          {#each STATUS_OPTIONS as opt (opt.value)}
            <button
              type="button"
              onclick={() => (statusFilter = opt.value)}
              class={`cursor-pointer rounded-none border-2 border-[#5c4429]/40 px-3 py-2 text-xs font-bold uppercase tracking-wide transition-all ${statusFilter === opt.value ? "bg-[#5c4429] text-white" : "bg-white hover:bg-[#5c4429]/10"}`}
            >
              {opt.label}
            </button>
          {/each}
        </div>
      </div>

      <div class="mb-4 flex flex-wrap items-center gap-2">
        <span class="text-xs font-bold uppercase tracking-wide text-black/50">Sort</span>
        <div class="flex flex-wrap gap-1.5">
          {#each SORT_OPTIONS as opt (opt.value)}
            <button
              type="button"
              onclick={() => (sortBy = opt.value)}
              class={`cursor-pointer rounded-none border-2 border-[#5c4429]/40 px-3 py-2 text-xs font-bold uppercase tracking-wide transition-all ${sortBy === opt.value ? "bg-app-gold text-black" : "bg-white hover:bg-[#5c4429]/10"}`}
            >
              {opt.label}
            </button>
          {/each}
        </div>
      </div>

      {#if filtered.length === 0}
        <p class="text-black/60">{items.length === 0 ? "Nothing here yet. Be the first!" : "No projects match."}</p>
      {:else}
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {#each filtered as project (project.id)}
            {@render projectCard(project)}
          {/each}
        </div>
      {/if}
    {/if}
  {/snippet}
</PopupShell>
