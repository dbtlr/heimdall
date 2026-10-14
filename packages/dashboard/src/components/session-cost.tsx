import type { ReactNode } from 'react';
import { Area, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from 'recharts';

import { clockSpan } from '../lib/phrase.ts';
import { formatTokens, modelColor, modelName } from '../lib/session-format.ts';
import { MAIN } from '../lib/session-search.ts';
import type { SessionSearch } from '../lib/session-search.ts';
import {
  commandMarks,
  contextFill,
  costBy,
  costByKind,
  runningCost,
  toolCounts,
} from '../lib/session.ts';
import type { AgentLane, TokenKind } from '../lib/session.ts';
import { formatCost } from '../lib/time.ts';
import type { SessionView } from '../server/session-view-types.ts';
import { PhraseText } from './date-time.tsx';
import { ProcessLinkBar } from './process-link-bar.tsx';
import { runName, sessionWindow } from './session-timeline.tsx';
import { SpanLabels } from './span-labels.tsx';
import { ChartContainer } from './ui/chart.tsx';

const NO_MARGIN = { bottom: 0, left: 0, right: 0, top: 0 };
const MAIN_COLOR = '#3d6fb8';
const SUBAGENT_COLOR = '#2a7a6d';

const KIND_STYLE: Record<TokenKind, { color: string; label: string }> = {
  cacheRead: { color: '#5b6683', label: 'read from cache' },
  cacheWrite: { color: '#8c96b0', label: 'written to cache' },
  input: { color: '#d5dbea', label: 'input' },
  output: { color: '#4a90ea', label: 'output' },
};

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={`mb-3.5 rounded-lg bg-card px-4 py-3.5 ${className ?? ''}`}>
      {children}
    </section>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2.5 text-[13.5px] font-normal text-muted-foreground">{children}</h2>;
}

// What the Session's priced requests paid for, by token kind.
function PaidFor({ view }: { view: SessionView }) {
  const kinds = costByKind(view.requests);
  const total = kinds.reduce((sum, kind) => sum + kind.costUsd, 0);
  return (
    <Card>
      <CardTitle>What the {formatCost(view.totals.pricedCostUsd)} paid for</CardTitle>
      <div className="flex h-3 overflow-hidden rounded-[3px]">
        {kinds.map((kind) => (
          <i
            key={kind.kind}
            style={{
              background: KIND_STYLE[kind.kind].color,
              width: `${String(total === 0 ? 0 : (kind.costUsd / total) * 100)}%`,
            }}
          />
        ))}
      </div>
      <ul className="mt-2.5 grid grid-cols-2 gap-y-2 sm:grid-cols-4">
        {kinds.map((kind) => (
          <li className="flex items-start gap-2 text-[13.5px]" key={kind.kind}>
            <i
              className="mt-[5px] inline-block h-2 w-3.5 flex-none rounded-[2px]"
              style={{ background: KIND_STYLE[kind.kind].color }}
            />
            <span>
              <b className="font-semibold">{formatCost(kind.costUsd)}</b>{' '}
              {KIND_STYLE[kind.kind].label}
              <br />
              <span className="text-muted-foreground">{formatTokens(kind.tokens)} tokens</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// The running list-price cost, main conversation under subagents, flagged
// where a subagent started from the main conversation and at slash commands;
// then the main conversation's context fill, and the process link.
function RunningCost({ lanes, view }: { lanes: readonly AgentLane[]; view: SessionView }) {
  const window = sessionWindow(view);
  const points = runningCost(view.requests);
  const context = contextFill(view.requests);
  const commands = commandMarks(view.requests, view.toolCalls);
  const compactions = commands.filter((command) => command.after !== undefined);
  const contextWindow = context.findLast((point) => point.window !== undefined)?.window;
  const flags = [
    ...lanes
      .filter((lane) => lane.depth === 1 && lane.workflowRun === undefined)
      .map((lane) => ({ at: lane.startedAt, label: lane.label })),
    ...commands.map((command) => ({ at: command.at, label: `/${command.name}` })),
  ];
  const domain = [window.from, window.to];
  return (
    <Card>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-4 text-[13.5px] text-muted-foreground">
        <span>Running list-price cost</span>
        <span className="inline-flex items-center gap-[5px] text-[12.5px]">
          <i className="inline-block h-2 w-3.5 rounded-[2px]" style={{ background: MAIN_COLOR }} />
          main conversation
        </span>
        <span className="inline-flex items-center gap-[5px] text-[12.5px]">
          <i
            className="inline-block h-2 w-3.5 rounded-[2px]"
            style={{ background: SUBAGENT_COLOR }}
          />
          subagents
        </span>
      </div>
      <ChartContainer
        aria-label="Running list-price cost"
        className="aspect-auto w-full"
        config={{}}
        initialDimension={{ height: 190, width: 1000 }}
        role="img"
        style={{ height: 190 }}
      >
        <ComposedChart data={points} margin={{ ...NO_MARGIN, top: 28 }}>
          <XAxis allowDataOverflow dataKey="t" domain={domain} hide type="number" />
          <YAxis
            axisLine={false}
            mirror
            tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
            tickFormatter={(value: number) => `$${String(value)}`}
            tickLine={false}
          />
          {flags.map((flag, index) => (
            <ReferenceLine
              key={`${flag.label}-${String(flag.at)}-${String(index)}`}
              label={{
                dy: -26 + (index % 2) * 13,
                fill: 'var(--muted-foreground)',
                fontSize: 11,
                position: 'insideTopLeft',
                value: flag.label,
              }}
              stroke="var(--border)"
              strokeDasharray="2 3"
              x={flag.at}
            />
          ))}
          <Area
            dataKey="main"
            fill={MAIN_COLOR}
            fillOpacity={0.85}
            isAnimationActive={false}
            stackId="cost"
            stroke="none"
            type="stepAfter"
          />
          <Area
            dataKey="subagents"
            fill={SUBAGENT_COLOR}
            fillOpacity={0.85}
            isAnimationActive={false}
            stackId="cost"
            stroke="none"
            type="stepAfter"
          />
        </ComposedChart>
      </ChartContainer>
      <SpanLabels window={window} />
      <p className="mt-3 mb-1 text-[13.5px] text-muted-foreground">
        Main conversation context
        {contextWindow === undefined ? '' : `, of a ${formatTokens(contextWindow)} window`}
      </p>
      <ChartContainer
        aria-label="Main conversation context"
        className="aspect-auto w-full"
        config={{}}
        initialDimension={{ height: 64, width: 1000 }}
        role="img"
        style={{ height: 64 }}
      >
        <ComposedChart data={context} margin={{ ...NO_MARGIN, top: 14 }}>
          <XAxis allowDataOverflow dataKey="t" domain={domain} hide type="number" />
          <YAxis domain={[0, 'dataMax']} hide />
          {compactions.map((command) => (
            <ReferenceLine
              key={command.at}
              label={{
                dy: -14,
                fill: 'var(--muted-foreground)',
                fontSize: 11,
                position: 'insideTopLeft',
                value: `compacted, ${formatTokens(command.before ?? 0)} to ${formatTokens(command.after ?? 0)}`,
              }}
              stroke="none"
              x={command.at}
            />
          ))}
          <Line
            dataKey="tokens"
            dot={false}
            isAnimationActive={false}
            stroke="#e7eaf3"
            strokeWidth={1.25}
            type="stepAfter"
          />
        </ComposedChart>
      </ChartContainer>
      <p className="mt-3 mb-1 text-[13.5px] text-muted-foreground">Process link</p>
      <ProcessLinkBar harness={view.harness} stretches={view.stretches} window={window} />
    </Card>
  );
}

// Each agent's requests, tokens, and cost; selecting one opens its requests
// in the Trace.
function ByAgent({
  go,
  lanes,
}: {
  go: (next: Partial<SessionSearch>) => void;
  lanes: readonly AgentLane[];
}) {
  const costliest = Math.max(0.000_001, ...lanes.map((lane) => lane.costUsd ?? 0));
  return (
    <Card className="lg:mb-0">
      <CardTitle>
        By agent{' '}
        <span className="ml-3 hidden text-xs sm:inline">
          Select an agent to see its requests in Trace.
        </span>
      </CardTitle>
      <table className="w-full text-[13.5px]">
        <thead>
          <tr className="border-b text-left text-[12.5px] text-muted-foreground">
            <th className="pb-1.5 font-normal">Agent</th>
            <th className="pb-1.5 font-normal">Requests</th>
            <th className="hidden pb-1.5 font-normal sm:table-cell">In and out</th>
            <th className="pb-1.5 font-normal">Cost</th>
            <th className="w-[22%]" />
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane, index) => {
            const run = lane.workflowRun;
            const startsRun = run !== undefined && lanes[index - 1]?.workflowRun !== run;
            const open = () =>
              go({
                agent: lane.agentId ?? MAIN,
                filter: 'everything',
                request: undefined,
                tab: 'trace',
              });
            return [
              startsRun && (
                <tr className="border-b" key={`run-${run}`}>
                  <td
                    className="pt-3 pb-1.5 text-[11.5px] tracking-[0.06em] text-muted-foreground uppercase"
                    colSpan={5}
                  >
                    {runName(lanes, run)}
                  </td>
                </tr>
              ),
              <tr className="border-b align-top hover:bg-accent/60" key={lane.agentId ?? 'main'}>
                <td className="py-2" style={{ paddingLeft: Math.max(0, lane.depth - 1) * 12 }}>
                  <button className="text-left" onClick={open} type="button">
                    {lane.depth > 0 && <span className="mr-1 text-muted-foreground">└</span>}
                    <b className="font-semibold">{lane.label}</b>
                    {lane.phase !== undefined && (
                      <span className="text-muted-foreground"> {lane.phase}</span>
                    )}
                    <br />
                    <span className="text-muted-foreground">
                      {lane.model === undefined ? '' : modelName(lane.model)}
                      <PhraseText
                        phrase={[
                          lane.model === undefined ? '' : ', ',
                          ...clockSpan(lane.startedAt, lane.endedAt),
                        ]}
                      />
                    </span>
                  </button>
                </td>
                <td className="py-2">{lane.requests.length}</td>
                <td className="hidden py-2 sm:table-cell">{formatTokens(lane.tokens)}</td>
                <td className="py-2">{formatCost(lane.costUsd)}</td>
                <td className="py-2 pt-3">
                  <div className="h-1.5 rounded-[2px] bg-accent">
                    <div
                      className="h-full rounded-[2px]"
                      style={{
                        background: modelColor(lane.model ?? ''),
                        width: `${String(((lane.costUsd ?? 0) / costliest) * 100)}%`,
                      }}
                    />
                  </div>
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </Card>
  );
}

type Bar = {
  color: string;
  key: string;
  label: ReactNode;
  note?: string;
  value: string;
  width: number;
};

function BarList({ bars, title }: { bars: readonly Bar[]; title: string }) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <ul>
        {bars.map((bar) => (
          <li className="py-1.5 text-[13.5px]" key={bar.key}>
            <p className="flex justify-between">
              <span>{bar.label}</span>
              <b className="font-semibold">{bar.value}</b>
            </p>
            <div className="mt-1 h-1.5 rounded-[2px] bg-accent">
              <div
                className="h-full rounded-[2px]"
                style={{ background: bar.color, width: `${String(bar.width * 100)}%` }}
              />
            </div>
            {bar.note !== undefined && (
              <p className="mt-0.5 text-[12.5px] text-muted-foreground">{bar.note}</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const share = (part: number, whole: number) =>
  whole === 0 ? '' : `, ${String(Math.round((part / whole) * 100))}%`;

// The Cost tab: what the cost paid for, how it ran up, and where it went by
// agent, model, skill, and tool.
export function SessionCost({
  go,
  lanes,
  view,
}: {
  go: (next: Partial<SessionSearch>) => void;
  lanes: readonly AgentLane[];
  view: SessionView;
}) {
  const priced = view.totals.pricedCostUsd;
  const models = costBy(view.requests, 'model');
  const skills = costBy(view.requests, 'skill');
  const tools = toolCounts(view.toolCalls);
  const calls = tools.reduce((sum, tool) => sum + tool.calls, 0);
  const most = Math.max(1, ...tools.map((tool) => tool.calls));
  const costliestSkill = Math.max(0.000_001, ...skills.map((skill) => skill.costUsd ?? 0));
  return (
    <>
      <PaidFor view={view} />
      <RunningCost lanes={lanes} view={view} />
      <div className="grid gap-x-3.5 lg:grid-cols-[1.4fr_1fr]">
        <ByAgent go={go} lanes={lanes} />
        <div>
          <BarList
            bars={models.map((model) => ({
              color: modelColor(model.key ?? ''),
              key: model.key ?? '',
              label: modelName(model.key ?? ''),
              note: `${String(model.requests)} requests${model.costUsd === undefined ? ', unpriced' : share(model.costUsd, priced)}`,
              value: formatCost(model.costUsd),
              width: priced === 0 ? 0 : (model.costUsd ?? 0) / priced,
            }))}
            title="By model"
          />
          <BarList
            bars={skills.map((skill) => ({
              color: '#8c96b0',
              key: skill.key ?? '',
              label: skill.key ?? 'No skill',
              note: `${String(skill.requests)} requests`,
              value: formatCost(skill.costUsd),
              width: (skill.costUsd ?? 0) / costliestSkill,
            }))}
            title="By skill"
          />
          <BarList
            bars={tools.map((tool) => ({
              color: '#8c96b0',
              key: `${tool.name}-${tool.mcpServer ?? ''}`,
              label: (
                <>
                  {tool.name}
                  {tool.mcpServer !== undefined && (
                    <span className="text-muted-foreground"> {tool.mcpServer}</span>
                  )}
                </>
              ),
              value: String(tool.calls),
              width: tool.calls / most,
            }))}
            title={`Tool calls, ${String(calls)}`}
          />
        </div>
      </div>
    </>
  );
}
