/**
 * The Steps view's second reading, as the rail draws it.
 *
 * The server answers with the anchor's body folded into blocks and forks
 * (`api/program.ts`); this turns that into what a reader sees — the boxes of
 * the picture in the code's order, the conditions as words, and one line for
 * every place the reading has to be honest about not being plain sequence
 * (work registered to run later, calls started together, a helper already read
 * above). Nothing here is geometry: the rail is a column of boxes with a
 * hairline down its left, and a fork is a row of columns, so the browser lays
 * it out and this file only decides what each thing SAYS.
 *
 * The words are the ones the rest of the view uses: `steps-model.ts` for a
 * box's two lines and the vocabulary a project is read in, `conditions.ts` for
 * WHEN / AND / OR / NOT. A fork carries its condition once, on its head; an
 * arm then says only which side it is — *when* and *when not* — except in a
 * `switch`, where each arm has a condition of its own to say.
 */

import { conditionTokens, whenTokens, type WordToken } from './conditions';
import { stepLabel, stepSub, type ProjectKind, type StepNodeInfo } from './steps-model';
import type { WireArm, WireArmEnd, WireBlock, WireItem, WireNodeRef, WireStep, WireStepsPayload } from './wire';

/** The construct a fork came from. */
export type ForkForm = Extract<WireItem, { kind: 'fork' }>['form'];

/** A step of the picture, where the code writes it. */
export interface RailStep {
  kind: 'step';
  id: string;
  /** The link it arrived on — the panel's rows for this site. */
  link: string | null;
  /** The box's words; null when the step is not in the picture (a cap removed it). */
  info: StepNodeInfo | null;
  /** The call this one is written inside the arguments of — `res.json`. */
  within: string | null;
  /** What it does, when the walk read on into it. */
  body: RailItem[];
  /** It happens here too, and was read above. */
  again: boolean;
}

export interface RailArm {
  /** WHEN / WHEN NOT, or a case's own condition. */
  words: WordToken[];
  /** What the arm's last line says when it stops there: `answers`, `returns`, `throws`, `leaves`. */
  ends: string | null;
  body: RailItem[];
}

export interface RailFork {
  kind: 'fork';
  /** The decision, in the conditions vocabulary. */
  words: WordToken[];
  /** The word for the construct: `if`, `switch`, `try`. */
  form: string;
  arms: RailArm[];
}

/** A run that is not plain sequence, bracketed and labelled. */
export interface RailGroup {
  kind: 'group';
  block: 'inline' | 'loop' | 'later' | 'together';
  /** `via generateToken`, `for each item of items`, `later · then`, `together`. */
  label: string;
  /** The helper drawn here, for its link to the symbol view. */
  via: WireNodeRef | null;
  within: string | null;
  again: boolean;
  body: RailItem[];
}

export interface RailCut {
  kind: 'cut';
  text: string;
}

export type RailItem = RailStep | RailFork | RailGroup | RailCut;

/**
 * The rail for a payload: its anchor's body in the code's order, or an empty
 * list when the server had nothing to read (a screen, an unreadable file).
 */
export function buildRailModel(payload: WireStepsPayload): RailItem[] {
  if (!payload.program) return [];
  const steps = new Map(payload.steps.map((s) => [s.id, s]));
  return block(payload.program.root, steps, payload.project);
}

function block(items: WireBlock, steps: Map<string, WireStep>, project: ProjectKind): RailItem[] {
  return items.map((item) => one(item, steps, project));
}

function one(item: WireItem, steps: Map<string, WireStep>, project: ProjectKind): RailItem {
  switch (item.kind) {
    case 'step': {
      const step = steps.get(item.step);
      return {
        kind: 'step',
        id: item.step,
        link: item.link ?? null,
        info: step ? { id: step.id, step, label: stepLabel(step), sub: stepSub(step, project) } : null,
        within: item.within ?? null,
        body: item.body ? block(item.body, steps, project) : [],
        again: item.again === true,
      };
    }
    case 'fork':
      return {
        kind: 'fork',
        // The head is the decision itself, said once; the arms say only which
        // side of it they are, so the head carries no WHEN of its own.
        words: whenTokens(item.on),
        form: item.form === 'switch' ? 'switch' : item.form === 'try' ? 'try' : 'if',
        arms: item.arms.map((arm) => ({
          words: armWords(item.form, item.on, arm),
          ends: arm.ends === null ? null : endWords(arm.ends),
          body: block(arm.body, steps, project),
        })),
      };
    case 'block':
      return {
        kind: 'group',
        block: item.block,
        label: groupLabel(item),
        via: item.via ?? null,
        within: item.within ?? null,
        again: item.again === true,
        body: block(item.body, steps, project),
      };
    default:
      return {
        kind: 'cut',
        text:
          item.why === 'folded'
            ? 'reads back into itself — the rest is the same code again'
            : 'as deep as this reading goes — start at a step below to read on',
      };
  }
}

/**
 * What an arm says. The fork already carries the condition, so the two sides of
 * an `if` say only which side they are; a `switch` arm has a condition of its
 * own, and so does an arm the reading could not match to the head.
 */
export function armWords(form: ForkForm, on: string, arm: WireArm): WordToken[] {
  // A case has a condition of its own to say; the one arm of a `try` is the
  // head (`on error`) and says nothing twice.
  if (form === 'switch') return conditionTokens(arm.when);
  if (form === 'try') return [];
  if (arm.not === true) return [{ kw: true, text: 'WHEN' }, { kw: true, text: 'NOT' }];
  if (arm.when === on) return [{ kw: true, text: 'WHEN' }];
  return conditionTokens(arm.when);
}

/** How an arm leaves, as a reader says it. */
export function endWords(end: WireArmEnd): string {
  switch (end) {
    case 'reply':
      return 'answers here';
    case 'return':
      return 'returns here';
    case 'throw':
      return 'throws here';
    default:
      return 'leaves here';
  }
}

/** The words on a bracketed run. */
export function groupLabel(item: Extract<WireItem, { kind: 'block' }>): string {
  switch (item.block) {
    case 'inline':
      return item.via ? `via ${item.via.name}` : 'via a helper';
    case 'loop':
      if (!item.by) return item.loop === 'while' ? 'again and again' : 'for each item';
      return item.loop === 'while' ? `again while ${item.by}` : `for each ${item.by}`;
    case 'later':
      return item.by ? `later · ${item.by}` : 'later';
    default:
      return item.by ? `together · ${item.by}` : 'together';
  }
}
