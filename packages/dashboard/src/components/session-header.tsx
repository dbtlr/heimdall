import { Link } from '@tanstack/react-router';

import { harnessName } from '../lib/lane.ts';
import { clockAt, whenAt } from '../lib/phrase.ts';
import { formatTokens, modelName } from '../lib/session-format.ts';
import { costBy, toolCounts } from '../lib/session.ts';
import type { AgentLane } from '../lib/session.ts';
import { formatCost, formatSpan } from '../lib/time.ts';
import type { SessionView } from '../server/session-view-types.ts';
import { PhraseText } from './date-time.tsx';

// "Claude Code 2.1.40 in ~/src/heimdall. 13:30 to 15:42, 2 h 12 min. Session 7f3c9a2e."
function PlaceLine({ now, view }: { now: number; view: SessionView }) {
  return (
    <>
      {harnessName(view.harness)}
      {view.harnessVersion === undefined ? '' : ` ${view.harnessVersion}`}
      {view.cwd === undefined ? '' : ` in ${view.cwd}`}.
      <PhraseText
        phrase={[' ', whenAt(view.startedAt, now), ' to ', clockAt(view.endedAt), ',']}
      />{' '}
      {formatSpan(view.endedAt - view.startedAt)}. Session {view.sessionId.slice(0, 8)}.
    </>
  );
}

function Total({ label, note, value }: { label: string; note: string; value: string }) {
  return (
    <div className="border-b border-r px-3 py-2.5 sm:border-b-0 sm:last:border-r-0">
      <p className="text-[12.5px] text-muted-foreground">{label}</p>
      <p className="text-[19px] font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

// How many subagents ran in a workflow run, of how many.
const subagentNote = (subagents: number, inRuns: number) => {
  if (subagents === 0) {
    return 'none';
  }
  return inRuns === 0 ? 'none in a workflow run' : `${String(inRuns)} in a workflow run`;
};

// What a Session's totals strip says about each of its totals.
const totals = (view: SessionView, lanes: readonly AgentLane[]) => {
  const { totals: sum } = view;
  const subagents = lanes.filter((lane) => lane.agentId !== undefined);
  const inRuns = subagents.filter((lane) => lane.workflowRun !== undefined).length;
  const tools = toolCounts(view.toolCalls);
  const calls = tools.reduce((all, tool) => all + tool.calls, 0);
  const models = costBy(view.requests, 'model');
  const top = models[0];
  const priced = sum.pricedCostUsd;
  return [
    {
      label: 'List-price cost',
      note:
        sum.unpricedRequests === 0
          ? 'every request priced'
          : `${String(sum.unpricedRequests)} requests unpriced`,
      value: sum.costUsd === undefined ? `${formatCost(priced)} priced` : formatCost(sum.costUsd),
    },
    {
      label: 'Requests',
      note: `${String(sum.mainRequests)} in the main conversation`,
      value: String(sum.requests),
    },
    {
      label: 'Tokens',
      note: `in and out, plus ${formatTokens(sum.cacheReadTokens)} read from cache and ${formatTokens(sum.cacheWriteTokens)} written to it`,
      value: formatTokens(sum.inputTokens + sum.outputTokens),
    },
    {
      label: 'Subagents',
      note: subagentNote(subagents.length, inRuns),
      value: String(subagents.length),
    },
    {
      label: 'Tool calls',
      note:
        tools.length === 0
          ? 'none'
          : `${tools
              .slice(0, 3)
              .map((tool) => tool.name)
              .join(', ')} most`,
      value: String(calls),
    },
    {
      label: models.length === 1 ? 'Model' : 'Models',
      note:
        top === undefined || models.length === 1 || top.costUsd === undefined || priced === 0
          ? 'every request'
          : `${modelName(top.key ?? '')} ${String(Math.round((top.costUsd / priced) * 100))}% of cost`,
      value: models.map((model) => modelName(model.key ?? '')).join(', '),
    },
  ];
};

// The Session's place and span, and its totals.
export function SessionHeader({
  lanes,
  now,
  view,
}: {
  lanes: readonly AgentLane[];
  now: number;
  view: SessionView;
}) {
  // As elsewhere, a Session's project is its working directory's last name.
  const project = view.cwd?.split('/').findLast((part) => part !== '');
  return (
    <>
      <div className="pt-3.5 pb-2.5 sm:pt-[18px]">
        <h1 className="text-[19px] font-semibold sm:text-[22px]">
          <Link className="text-muted-foreground" to="/">
            Fleet
          </Link>{' '}
          /{' '}
          <Link
            className="text-muted-foreground"
            params={{ name: view.system }}
            to="/systems/$name"
          >
            {view.system}
          </Link>{' '}
          / {project ?? `${harnessName(view.harness)} Session`}
          {view.branch !== undefined && (
            <span className="font-medium text-muted-foreground"> on {view.branch}</span>
          )}
        </h1>
        <p className="text-muted-foreground">
          <PlaceLine now={now} view={view} />
        </p>
      </div>
      <section
        aria-label="Totals"
        className="grid grid-cols-2 overflow-hidden rounded-lg border bg-card sm:grid-cols-6"
      >
        {totals(view, lanes).map((total) => (
          <Total key={total.label} {...total} />
        ))}
      </section>
    </>
  );
}
