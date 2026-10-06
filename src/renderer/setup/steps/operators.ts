/**
 * Step 4: who may drive the agent.
 *
 * The allowlist is the app's only authority boundary. Everything the agent does
 * runs on this machine, as this user, with whatever permission mode the next
 * step grants, so an unresolved entry is a real problem and not a formatting
 * nit. This step cannot be advanced with zero resolved operators, which mirrors
 * the service refusing to start when the allowlist resolves to nobody.
 */

import type { AllowedUser, AllowlistResolution, SlackWorkspaceUser } from '../../../shared/contract.ts';
import { checkRow } from '../checks-ui.ts';
import { Bag, button, card, chip, el, emptyState, textField } from '../ui.ts';
import type { StepContext, StepHandle, StepModule } from './types.ts';

/** How many workspace rows to draw before asking the operator to narrow the search. */
const PICKER_LIMIT = 40;

function normaliseEntry(entry: string): string {
  return entry.trim().replace(/^@/, '').toLowerCase();
}

function isSameEntry(a: string, b: string): boolean {
  return normaliseEntry(a) === normaliseEntry(b);
}

/**
 * `AllowlistResolution` reports which entries failed and which users were
 * found, but not the pairing between them. Correlate on the id and the handle
 * first, which covers every entry added from the picker, and only then fall
 * back to consuming the leftovers in order. The set of ids that gets persisted
 * is exactly `resolution.resolved` either way; this only decides which label
 * sits on which chip.
 */
function applyResolution(entries: AllowedUser[], resolution: AllowlistResolution): AllowedUser[] {
  const pool = [...resolution.resolved];
  const stamp = new Date().toISOString();

  const take = (predicate: (user: { id: string; name: string }) => boolean): { id: string; name: string } | undefined => {
    const index = pool.findIndex(predicate);
    return index === -1 ? undefined : pool.splice(index, 1)[0];
  };

  const next = entries.map((entry) => ({ ...entry }));

  for (const entry of next) {
    if (resolution.unresolved.some((failed) => isSameEntry(failed, entry.entry))) {
      delete entry.id;
      delete entry.name;
      delete entry.resolvedAt;
      continue;
    }
    const match =
      take((user) => user.id.toLowerCase() === normaliseEntry(entry.entry)) ??
      take((user) => user.name.toLowerCase() === normaliseEntry(entry.entry));
    if (match) {
      entry.id = match.id;
      entry.name = match.name;
      entry.resolvedAt = stamp;
    }
  }

  // Anything left over belongs to an entry that resolved but could not be
  // paired by id or handle, e.g. an email address.
  for (const entry of next) {
    if (entry.id) continue;
    if (resolution.unresolved.some((failed) => isSameEntry(failed, entry.entry))) continue;
    const match = pool.shift();
    if (!match) continue;
    entry.id = match.id;
    entry.name = match.name;
    entry.resolvedAt = stamp;
  }

  return next;
}

export const operatorsStep: StepModule = {
  id: 'operators',
  label: 'Operators',
  title: 'Who may drive it',
  subtitle: 'Only these Slack accounts are answered. Every other DM is read and ignored.',

  mount(ctx: StepContext): StepHandle {
    const bag = new Bag();
    let entries: AllowedUser[] = ctx.state.config.slack.allowed.map((entry) => ({ ...entry }));
    let workspace: SlackWorkspaceUser[] | null = null;
    /** Normalised entries Slack could not find. Distinguishes "rejected" from "not looked up yet". */
    const failed = new Set<string>();
    let pickerOpen = false;
    let pickerQuery = '';
    let showBots = false;

    const row = checkRow('Allowlist', 'Add at least one account, then verify.');
    const chipSlot = el('div', { class: 'row' });
    const pickerSlot = el('div', { class: 'stack' });

    const addField = textField({
      label: 'Add by handle, user id, or email',
      placeholder: '@yourname, U012ABC3DEF, or you@example.com',
      hint: 'A user id is the safest entry: it survives a display-name change. The picker below fills them in for you.',
      onEnter: () => addTyped(),
    });

    function addTyped(): void {
      const raw = addField.input.value.trim();
      if (!raw) return;
      if (entries.some((entry) => isSameEntry(entry.entry, raw))) {
        addField.setError('That entry is already on the list.');
        return;
      }
      entries.push({ entry: raw.replace(/^@/, '') });
      addField.input.value = '';
      addField.setError(null);
      renderChips();
      ctx.refresh();
    }

    function removeEntry(entry: AllowedUser): void {
      entries = entries.filter((candidate) => candidate !== entry);
      renderChips();
      void persist();
      ctx.refresh();
    }

    function renderChips(): void {
      chipSlot.replaceChildren();
      if (entries.length === 0) {
        chipSlot.appendChild(emptyState('Nobody yet. Add yourself first.'));
        return;
      }
      for (const entry of entries) {
        const tone = entry.id ? 'ok' : failed.has(normaliseEntry(entry.entry)) ? 'bad' : 'pending';
        const label = entry.name ? `${entry.name} (${entry.id ?? entry.entry})` : entry.entry;
        chipSlot.appendChild(chip(label, tone, () => removeEntry(entry)));
      }
    }

    async function persist(): Promise<void> {
      const saved = await ctx.state.save({ slack: { allowed: entries } });
      if (!saved.ok) ctx.say(`Could not save the allowlist: ${saved.error}`, 'bad');
    }

    async function verify(): Promise<void> {
      if (entries.length === 0) {
        row.setIdle('Add at least one account, then verify.');
        return;
      }
      row.setRunning();
      ctx.say('Looking these up in Slack…');
      const result = await window.api.resolveAllowlist(entries.map((entry) => entry.entry));
      row.setResult(result);

      const resolution = result.data as AllowlistResolution | undefined;
      if (resolution) {
        failed.clear();
        for (const entry of resolution.unresolved) failed.add(normaliseEntry(entry));
        entries = applyResolution(entries, resolution);
        renderChips();
        await persist();
      }

      const resolved = entries.filter((entry) => entry.id).length;
      if (resolved === 0) ctx.say('None of those resolved. Check the spelling, or use the picker.', 'bad');
      else if (resolved < entries.length) ctx.say(`${resolved} of ${entries.length} resolved. The red ones will be ignored.`, 'warn');
      else ctx.say('All resolved.', 'ok');
      ctx.refresh();
    }

    function renderPicker(): void {
      if (!pickerOpen) {
        pickerSlot.replaceChildren();
        return;
      }
      if (workspace === null) {
        pickerSlot.replaceChildren(card({ title: 'Workspace members', body: [el('p', { class: 'field-hint', text: 'Loading…' })] }));
        return;
      }

      const query = pickerQuery.trim().toLowerCase();
      const matches = workspace.filter((user) => {
        if (user.deleted) return false;
        if (user.isBot && !showBots) return false;
        if (!query) return true;
        return (
          user.name.toLowerCase().includes(query) ||
          user.realName.toLowerCase().includes(query) ||
          user.displayName.toLowerCase().includes(query) ||
          user.id.toLowerCase().includes(query)
        );
      });

      const list = el('div', { class: 'stack' });
      for (const user of matches.slice(0, PICKER_LIMIT)) {
        const already = entries.some((entry) => isSameEntry(entry.entry, user.id) || isSameEntry(entry.entry, user.name));
        list.appendChild(
          el(
            'div',
            { class: 'row spread hairline' },
            el(
              'div',
              { class: 'stack' },
              el('span', { class: 'field-label', text: user.realName || user.displayName || user.name }),
              el('span', { class: 'field-hint', text: `@${user.name} · ${user.id}${user.isBot ? ' · bot' : ''}` }),
            ),
            already
              ? el('span', { class: 'chip chip-ok', text: 'added' })
              : button('Add', {
                  onClick: () => {
                    entries.push({ entry: user.id, name: user.realName || user.name });
                    renderChips();
                    renderPicker();
                    ctx.refresh();
                  },
                }),
          ),
        );
      }
      if (matches.length === 0) list.appendChild(emptyState('Nobody matches that.'));

      const search = textField({
        label: 'Search',
        placeholder: 'Name, handle, or user id',
        value: pickerQuery,
        onInput: (value) => {
          pickerQuery = value;
          renderPicker();
          // Re-rendering blows the focus away, so put it back where it was.
          const input = pickerSlot.querySelector<HTMLInputElement>('.input');
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        },
      });

      pickerSlot.replaceChildren(
        card({
          title: 'Workspace members',
          subtitle:
            matches.length > PICKER_LIMIT
              ? `Showing ${PICKER_LIMIT} of ${matches.length}. Narrow the search to see the rest.`
              : `${matches.length} shown.`,
          body: [
            search.wrap,
            list,
            el(
              'label',
              { class: 'row' },
              el('input', {
                type: 'checkbox',
                attrs: { checked: showBots },
                onChange: () => {
                  showBots = !showBots;
                  renderPicker();
                },
              }),
              el('span', { class: 'field-hint', text: 'Include bots' }),
            ),
          ],
          footer: [
            button('Close', {
              variant: 'ghost',
              onClick: () => {
                pickerOpen = false;
                renderPicker();
              },
            }),
          ],
        }),
      );
    }

    async function openPicker(): Promise<void> {
      pickerOpen = true;
      renderPicker();
      if (workspace !== null) return;
      const result = await window.api.listWorkspaceUsers();
      if (!result.ok) {
        workspace = [];
        pickerSlot.replaceChildren(
          card({
            title: 'Workspace members',
            body: [
              el('p', { class: 'field-error', text: result.error }),
              el('p', { class: 'field-hint', text: 'The users:read scope is what this needs. Add it, reinstall the app, and try again.' }),
            ],
          }),
        );
        return;
      }
      workspace = result.value;
      renderPicker();
    }

    ctx.body.append(
      card({
        title: 'Allowed accounts',
        subtitle: 'The service refuses to start if this list resolves to nobody.',
        body: [chipSlot, addField.wrap, row.node],
        footer: [
          button('Add', { onClick: addTyped }),
          button('Pick from workspace', {
            onClick: () => {
              void openPicker();
            },
          }),
          button('Verify with Slack', {
            variant: 'primary',
            onClick: () => {
              void verify();
            },
          }),
        ],
      }),
      pickerSlot,
      card({
        title: 'What this actually gates',
        body: [
          el('p', {
            class: 'field-hint',
            text: 'A DM from anyone not on this list is read from the socket, counted, and dropped. It never reaches the agent, so it can never run a command on this machine.',
          }),
          el('p', {
            class: 'field-hint',
            text: 'Add yourself. The bot can only be DMed by people in the same workspace, and the bot has to be able to open a DM with them.',
          }),
        ],
      }),
    );

    renderChips();
    if (entries.length > 0 && entries.some((entry) => !entry.id)) void verify();

    return {
      destroy: () => bag.dispose(),
      canAdvance: () => entries.some((entry) => Boolean(entry.id)),
      async beforeNext() {
        await persist();
        return true;
      },
    };
  },
};
