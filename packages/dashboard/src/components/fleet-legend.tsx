import { ConditionGlyph } from './condition-glyph.tsx';

const SWATCH = 'inline-block h-2 w-3.5 flex-none rounded-[2px]';

// What the lanes' colors and glyphs mean.
export function FleetLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
      <span className="inline-flex items-center gap-[5px]">
        <i className="inline-block h-[7px] w-3.5 flex-none rounded-[2px] border-t-2 border-[#d5dbea] bg-[rgba(150,170,215,0.22)]" />
        CPU busy, with 5-minute low and high
      </span>
      <span className="inline-flex items-center gap-[5px]">
        <i className={`${SWATCH} bg-chart-1`} />
        Claude Code Session
      </span>
      <span className="inline-flex items-center gap-[5px]">
        <i className={`${SWATCH} bg-chart-2`} />
        Codex Session
      </span>
      <span className="inline-flex items-center gap-[5px]">
        <ConditionGlyph kind="alert" />
        alert
        <ConditionGlyph kind="warning" />
        warning
        <ConditionGlyph kind="note" />
        note · raised or level changed
      </span>
      <span className="inline-flex items-center gap-[5px]">
        <ConditionGlyph kind="cleared" />
        cleared
      </span>
    </p>
  );
}
