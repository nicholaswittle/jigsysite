# Jigsy's — Before Go-Live Checklist

Everything that must be true before this site replaces jigsypizza.com as Jigsy's
official web presence. Nothing here is optional; several items are legal or
factual accuracy, not polish.

Last updated 2026-07-31.

---

## Blockers — must be done before the site is public

### 1. Replace the photography ⚠️ highest priority

The current food and lounge photos were **pulled from public Google guest
uploads** for the concept demo. Guest-uploaded photos belong to the guests who
took them, not to Jigsy's and not to us. Using them on a live commercial site
is a copyright exposure that survives the site going live.

Every one of them must be replaced with owner-supplied originals, or with photos
we take ourselves, before launch. This is not a "nice to have before we polish."

**Owner action:** Jigsy's needs to supply real photos. This is currently the
longest-lead item on the list — start it first.

### 2. Verify the menu, prices, and hours with the owner

Menu, prices, hours, and contact details were transcribed from Jigsy's published
**Nov 2025** menu. That is now eight months stale. Every price is a claim their
customers will hold them to.

Have the owner confirm the current menu and pricing in writing before launch,
and confirm the hours block matches what they actually run (the old site listed
"Summer 2026 Hours" with Sunday–Tuesday closed).

### 3. Remove the concept disclaimer

`index.html:1497` — the `.concept-note` paragraph reading *"Independent redesign
concept — not the official Jigsy's site…"*.

**Leave it in place until items 1 and 2 are done.** While the photos are still
guest uploads and the prices are unverified, that disclaimer is doing real work.
It comes out last, not first.

### 4. Rotate the Supabase secret key

The `sb_secret_…` key was pasted into a chat transcript on 2026-07-31 while
debugging the `check-capacity` scheduler. It is the key the edge functions
receive as `SUPABASE_SERVICE_ROLE_KEY`, and it bypasses every RLS policy in the
project. Deferred deliberately at the time — rotating mid-debug adds a variable
— but it must not survive to launch.

Sequence, once things are stable:

1. Settings → API Keys → revoke and reissue the secret key.
2. Redeploy the edge functions so they pick up the new value (from PowerShell,
   so Docker is on PATH).
3. Re-run the self-verifying Vault block against the new digest — the one that
   hashes the pasted key and refuses to store a mismatch.

Also delete `apex_v2/supabase/service role key.txt`. Vault holds the real
value now, and that file is a plaintext credential in a working tree.

### 5. Point the site at their real domain

`restaurant_settings.site_url` is still unset or pointing at a preview URL. It
must be their real https domain before launch, because guest checkout return
URLs are built from it — an https origin is required and a non-https value is
silently ignored.

Coordinate the DNS cutover from jigsypizza.com with the owner.

---

## Verify before launch

- [ ] Test the site logged out, in a private window, on a phone. Guest ordering
      has broken twice specifically because it was only ever tested while signed
      in — RLS hides missing public access from an authenticated session.
- [ ] Google review link goes to their review form, not a Maps listing.
- [ ] Facebook link resolves to facebook.com/jigsysoldforgepizza.
- [ ] Instagram link resolves to their real account.
- [ ] Staff console is not reachable or discoverable from public navigation.
- [ ] WiSense credit is present in the footer.
- [ ] Sticky section nav works on mobile, not just desktop.

---

## Payments — do not enable until these are true

Online ordering is built but **must not be turned on** for guests until:

- [ ] Tips are recorded end-to-end (`tip_cents`). See Phase 1 of
      `apex_v2/docs/PAYMENTS_AND_POS_BUILD_PLAN_2026-07-31.md`.
      **`allow_tipping` is already live on the Square rail while `tip_cents`
      does not exist**, which means a rejected order currently refunds the food
      and silently keeps the customer's tip.
- [ ] The provider is correct for whichever rail Jigsy actually signs. They are
      on Stripe today; Square requires the owner's credentials, not Emily's.
- [ ] A real order has been placed, paid, and refunded end to end.

---

## After launch

- [ ] Update the wisensellc.com case study from *"In Final Review"* to live, and
      link it. Currently in `wisense_horizon_v2/marketing/src/app/page.js`
      (redesign section) and `src/components/WorkShowcase.js`.
- [ ] Remove the "stylized representation" wording from the case-study note and
      replace the mock with a real screenshot.
