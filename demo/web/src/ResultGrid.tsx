import { useMemo } from 'react';

export interface QueryResultData {
  columns: string[];
  rows: string[][];
  totalRows: number;
  truncated: boolean;
  elapsedMs: number;
}

const MAX_ROWS = 500;

const bigintReplacer = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

function isStructField(type: unknown): boolean {
  return String(type).startsWith('Struct');
}

function isTimestampField(type: unknown): boolean {
  return String(type).startsWith('Timestamp');
}

function formatValue(value: unknown, timestamp: boolean): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && timestamp) {
    // Arrow hands timestamps back as a bare number in the column unit; duckdb
    // uses microseconds. Guess the unit from the magnitude.
    const ms = value > 1e14 ? value / 1e3 : value > 1e11 ? value : value * 1e3;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().replace('T', ' ').replace('Z', '');
  }
  if (typeof value === 'object') return JSON.stringify(value, bigintReplacer);
  return String(value);
}

export function tableToGrid(table: {
  schema: {
    fields: Array<{
      name: string;
      type: unknown;
      children?: Array<{ name: string }>;
    } & { type: { children?: Array<{ name: string }> } }>;
  };
  numRows: number;
  toArray: () => Array<Record<string, unknown>>;
  } , elapsedMs: number): QueryResultData {
  // STRUCT columns (e.g. jev_ask's signal) are flattened one level deep into
  // `signal.action` / `signal.risk` style sub-columns. Newer arrow versions
  // expose struct children on field.type.children rather than field.children.
  const flat: Array<{ label: string; read: (row: Record<string, unknown>) => string }> = [];
  for (const field of table.schema.fields) {
    const children = field.children ?? field.type?.children;
    if (isStructField(field.type) && children && children.length > 0) {
      for (const child of children) {
        flat.push({
          label: `${field.name}.${child.name}`,
          read: (row) => {
            const parent = row[field.name];
            const value =
              parent !== null && typeof parent === 'object'
                ? (parent as Record<string, unknown>)[child.name]
                : parent;
            return formatValue(value, false);
          },
        });
      }
    } else {
      const timestamp = isTimestampField(field.type);
      flat.push({ label: field.name, read: (row) => formatValue(row[field.name], timestamp) });
    }
  }

  const allRows = table.toArray();
  const truncated = allRows.length > MAX_ROWS;
  const rows = allRows.slice(0, MAX_ROWS).map((row) => flat.map((col) => col.read(row)));
  return {
    columns: flat.map((col) => col.label),
    rows,
    totalRows: allRows.length,
    truncated,
    elapsedMs,
  };
}

export default function ResultGrid({ result }: { result: QueryResultData }) {
  const footer = useMemo(
    () =>
      `${result.totalRows} row${result.totalRows === 1 ? '' : 's'} in ${result.elapsedMs.toFixed(0)} ms` +
      (result.truncated ? ` — showing first ${MAX_ROWS}` : ''),
    [result],
  );
  return (
    <div className="result-grid-wrap">
      <table className="result-grid">
        <thead>
          <tr>
            {result.columns.map((col) => (
              <th key={col}>{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={cell === 'NULL' ? 'null-cell' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="result-footer">{footer}</div>
    </div>
  );
}
