<script>
  // Three stages: confirm quantity (client-side only) → POST /shop/:id/buy
  // (moles actually spent) → a fulfillment form, which forwards straight to
  // Airtable and is never persisted (same pattern as SubmissionModal.svelte).
  import { apiFetch } from "../lib/api-client";
  import PopupShell from "./room/PopupShell.svelte";
  import moleIcon from "../Images/mole.png";

  let { itemId, itemName, priceMoles, userBalance, userEmail } = $props();

  /** @type {'idle' | 'confirm' | 'fulfillment' | 'done'} */
  let stage = $state("idle");
  let quantity = $state(1);
  let buying = $state(false);
  let error = $state("");

  // Set once the purchase succeeds — the fulfillment request needs to
  // know which order it's attached to.
  let orderId = $state(null);

  let firstName = $state("");
  let lastName = $state("");
  let addressLine1 = $state("");
  let addressLine2 = $state("");
  let city = $state("");
  let stateProvince = $state("");
  let country = $state("");
  let zip = $state("");
  let phone = $state("");
  let deliveryNotes = $state("");
  let submittingFulfillment = $state(false);

  const canAfford = $derived(userBalance >= priceMoles);
  const maxQuantity = $derived(Math.max(1, Math.min(20, Math.floor(userBalance / priceMoles) || 1)));
  const totalCost = $derived(priceMoles * quantity);

  function openConfirm() {
    if (!canAfford) return;
    quantity = 1;
    error = "";
    stage = "confirm";
  }

  function backToIdle() {
    if (buying || submittingFulfillment) return;
    stage = "idle";
  }

  async function confirmBuy() {
    buying = true;
    error = "";
    try {
      const res = await apiFetch(`/shop/${itemId}/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.error === "not_eligible") {
          // Full navigation, not a client-side route change — /blocked
          // reads the session server-side, which this same request just updated.
          window.location.href = "/blocked";
          return;
        }
        throw new Error(
          body.error === "insufficient_balance" ? "You don't have enough moles." : "Purchase failed.",
        );
      }
      const order = await res.json();
      orderId = order.id;
      stage = "fulfillment";
    } catch (err) {
      error = err instanceof Error ? err.message : "Something went wrong.";
    } finally {
      buying = false;
    }
  }

  // Matches the backend's fullName regex (letters + spaces only) — strips
  // as-you-type so the field can never hold something the submit will reject.
  function onlyLettersAndSpaces(event) {
    return event.currentTarget.value.replace(/[^A-Za-z ]/g, "");
  }

  async function submitFulfillment(event) {
    event.preventDefault();
    submittingFulfillment = true;
    error = "";

    try {
      const res = await apiFetch(`/shop/orders/${orderId}/fulfillment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Split here for a clearer form; the backend's fulfillmentSchema
          // only has one "Full Name" field, so it's rejoined before sending.
          fullName: `${firstName.trim()} ${lastName.trim()}`.trim(),
          addressLine1: addressLine1.trim(),
          addressLine2: addressLine2.trim() || undefined,
          city: city.trim(),
          stateProvince: stateProvince.trim(),
          country: country.trim(),
          zip: zip.trim(),
          phone: phone.trim(),
          notes: deliveryNotes.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error("Couldn't save your shipping info.");
      stage = "done";
    } catch (err) {
      error = err instanceof Error ? err.message : "Something went wrong.";
    } finally {
      submittingFulfillment = false;
    }
  }

  const fieldClass =
    "rounded-none border-2 border-[#5c4429]/40 bg-white px-3 py-2 font-normal outline-none focus:border-[#5c4429]";

  // Grows a textarea to fit typed content, up to the `max-h-40` cap on the
  // one textarea using it — overflow-y-auto takes over past that.
  function autoResize(node) {
    function resize() {
      node.style.height = "auto";
      node.style.height = `${node.scrollHeight}px`;
    }
    resize();
    node.addEventListener("input", resize);
    return {
      destroy() {
        node.removeEventListener("input", resize);
      },
    };
  }
</script>

<button
  type="button"
  onclick={openConfirm}
  disabled={!canAfford}
  class="w-full cursor-pointer rounded-none border-2 border-[#5c4429] bg-app-mint px-5 py-2 text-sm font-bold uppercase tracking-wide hover:bg-app-mint/70 disabled:cursor-not-allowed disabled:opacity-30"
>
  {canAfford ? "Buy" : "Not enough moles"}
</button>

{#if stage === "confirm"}
  <PopupShell title="Confirm purchase" maxWidth="max-w-sm" onClose={backToIdle}>
    {#snippet children()}
      <div class="flex flex-col items-center gap-4 text-center">
        <p>
          Buy <strong>{itemName}</strong>?
        </p>

        <label class="flex items-center gap-3 text-sm font-bold">
          Quantity
          <input
            type="number"
            min="1"
            max={maxQuantity}
            bind:value={quantity}
            class="w-20 rounded-none border-2 border-[#5c4429]/40 bg-white px-2 py-1.5 text-center outline-none focus:border-[#5c4429]"
          />
        </label>

        <p class="flex items-center gap-2 text-xl font-bold">
          <img src={moleIcon.src} alt="" width="24" height="24" class="h-6 w-6 shrink-0" />
          {totalCost}
        </p>

        {#if error}
          <p class="text-sm text-app-orange">{error}</p>
        {/if}

        <div class="flex gap-3">
          <button
            type="button"
            onclick={backToIdle}
            class="cursor-pointer rounded-none border-2 border-[#5c4429]/40 bg-white px-4 py-2 text-sm font-bold uppercase tracking-wide hover:bg-black/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onclick={confirmBuy}
            disabled={buying || totalCost > userBalance}
            class="cursor-pointer rounded-none border-2 border-[#5c4429] bg-app-mint px-4 py-2 text-sm font-bold uppercase tracking-wide hover:bg-app-mint/70 disabled:opacity-30"
          >
            {buying ? "Buying..." : "Confirm"}
          </button>
        </div>
      </div>
    {/snippet}
  </PopupShell>
{/if}

{#if stage === "fulfillment"}
  <PopupShell title="Shipping info" subtitle="Enter your shipping information." maxWidth="max-w-xl" onClose={backToIdle}>
    {#snippet children()}
      <form onsubmit={submitFulfillment} class="flex flex-col gap-4">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm font-bold">
            First name
            <input type="text" value={firstName} oninput={(e) => (firstName = onlyLettersAndSpaces(e))} required class={fieldClass} />
          </label>
          <label class="flex flex-col gap-1 text-sm font-bold">
            Last name
            <input type="text" value={lastName} oninput={(e) => (lastName = onlyLettersAndSpaces(e))} required class={fieldClass} />
          </label>
        </div>
        <p class="-mt-2 text-xs font-normal text-black/50">
          Please use your real (legal) first and last name. This is what goes on your shipping
          label.
        </p>

        <p class="-mt-2 text-xs font-normal text-black/50">
          Tracking info, if any, will be sent to your account email ({userEmail}).
        </p>

        <label class="flex flex-col gap-1 text-sm font-bold">
          Address line 1
          <input type="text" bind:value={addressLine1} required class={fieldClass} />
        </label>
        <label class="flex flex-col gap-1 text-sm font-bold">
          Address line 2 <span class="font-normal text-black/50">(optional)</span>
          <input type="text" bind:value={addressLine2} class={fieldClass} />
        </label>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm font-bold">
            City
            <input type="text" bind:value={city} required class={fieldClass} />
          </label>
          <label class="flex flex-col gap-1 text-sm font-bold">
            State / Province
            <input type="text" bind:value={stateProvince} required class={fieldClass} />
          </label>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm font-bold">
            Country
            <input type="text" bind:value={country} required class={fieldClass} />
          </label>
          <label class="flex flex-col gap-1 text-sm font-bold">
            ZIP / Postal code
            <input type="text" bind:value={zip} required class={fieldClass} />
          </label>
        </div>
        <label class="flex flex-col gap-1 text-sm font-bold">
          Phone number
          <input type="tel" bind:value={phone} required class={fieldClass} />
        </label>

        <label class="flex flex-col gap-1 text-sm font-bold">
          Delivery notes <span class="font-normal text-black/50">(optional)</span>
          <textarea
            bind:value={deliveryNotes}
            maxlength="1000"
            rows="3"
            placeholder="Gate code, apartment/suite number, best time to deliver, anything else worth knowing..."
            use:autoResize
            class={`${fieldClass} max-h-40 resize-none overflow-y-auto`}
          ></textarea>
          <span class="text-xs font-normal text-black/50">
            Anything specific the person shipping this should know.
          </span>
        </label>

        {#if error}
          <p class="text-sm text-app-orange">{error}</p>
        {/if}

        <button
          type="submit"
          disabled={submittingFulfillment}
          class="mt-2 w-fit cursor-pointer rounded-none border-2 border-[#5c4429] bg-app-mint px-4 py-2 text-sm font-bold uppercase tracking-wide hover:bg-app-mint/70 disabled:opacity-30"
        >
          {submittingFulfillment ? "Saving..." : "Confirm"}
        </button>
      </form>
    {/snippet}
  </PopupShell>
{/if}

{#if stage === "done"}
  <PopupShell title="Thank you!" maxWidth="max-w-sm" onClose={() => (stage = "idle")}>
    {#snippet children()}
      <div class="flex flex-col items-center gap-4 text-center">
        <div class="w-full rounded-none border-2 border-[#5c4429]/30 bg-white/60 p-4 text-left">
          <p class="mb-2 text-xs font-bold uppercase tracking-wide text-black/50">Order summary</p>
          <div class="flex items-center justify-between text-sm">
            <span>{itemName}</span>
            <span class="font-bold">&times;{quantity}</span>
          </div>
          <div class="mt-2 flex items-center justify-between border-t-2 border-[#5c4429]/20 pt-2 text-sm font-bold">
            <span>Total</span>
            <span class="flex items-center gap-1.5">
              <img src={moleIcon.src} alt="" width="18" height="18" class="h-[18px] w-[18px] shrink-0" />
              {totalCost} moles
            </span>
          </div>
        </div>
        <p class="text-sm text-black/70">
          Your item is being ordered. Check your email soon for more details and an estimated
          delivery time.
        </p>
        <button
          type="button"
          onclick={() => (stage = "idle")}
          class="cursor-pointer rounded-none border-2 border-[#5c4429]/40 bg-white px-5 py-2 text-sm font-bold uppercase tracking-wide hover:bg-black hover:text-white"
        >
          Close
        </button>
      </div>
    {/snippet}
  </PopupShell>
{/if}
