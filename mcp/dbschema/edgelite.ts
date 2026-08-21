// GENERATED — do not edit. Regenerate with: edgelite codegen
// Normally regenerated from schema.esdl via `@edgelite/edgelite`'s codegen CLI, but that
// package's `edgelite codegen` command is broken on npm (0.2.0 ships cli/index.ts importing
// from ../src/*, which is not included in the published package's `files`). Committed here
// as a workaround until that upstream packaging bug is fixed.
// Import it via a relative path from the consuming project root.
import type { Query, SelectBuilder, InsertBuilder, UpdateBuilder, CountBuilder, NeighborsBuilder, FtsBuilder, FilterExpr, FieldRef, OrderByClause, OpExpr, AllExpr, AnyExpr } from 'edgelite/codegen';

const NodeKind = {
  session: 'session' as const,
  file_chunk: 'file_chunk' as const,
  tool_output: 'tool_output' as const,
  summary: 'summary' as const,
  note: 'note' as const,
  observation: 'observation' as const,
  web_chunk: 'web_chunk' as const,
  prompt: 'prompt' as const,
  thinking: 'thinking' as const,
  response: 'response' as const
};

const NodeStatus = {
  pending: 'pending' as const,
  live: 'live' as const,
  stale: 'stale' as const,
  superseded: 'superseded' as const,
  pruned: 'pruned' as const
};

const EdgeKind = {
  derived_from: 'derived_from' as const,
  references: 'references' as const,
  summarizes: 'summarizes' as const,
  supersedes: 'supersedes' as const,
  follows: 'follows' as const
};

const Node = { _table: 'nodes', _links: ['parent'] as const };

const Edge = { _table: 'edges', _links: ['src', 'dst'] as const };

const e = {
  Node: Node,
  Edge: Edge,
  NodeKind,
  NodeStatus,
  EdgeKind,
  select<T>(typeHandle: TypeHandle, shape: (ref: any) => any): SelectBuilder<T> {
    const ref = makeRef(typeHandle._table, typeHandle._links);
    const resolved = shape(ref);
    const { filter, orderBy, limit, ...fields } = resolved;
    return { kind: 'select', table: typeHandle._table, shape: fields, filter, orderBy, limit } as SelectBuilder<T>;
  },
  insert<T>(typeHandle: TypeHandle, data: Record<string, unknown>): InsertBuilder<T> {
    const builder: InsertBuilder<T> = {
      kind: 'insert', table: typeHandle._table, _links: typeHandle._links, data,
      _type: undefined as unknown as T,
      unlessConflict() { return { ...this, onConflict: 'ignore' }; },
    };
    return builder;
  },
  update<T>(typeHandle: TypeHandle, fn: (ref: any) => { filter: FilterExpr; set: Record<string, unknown> }): UpdateBuilder<T> {
    const ref = makeRef(typeHandle._table, typeHandle._links);
    const { filter, set } = fn(ref);
    return { kind: 'update', table: typeHandle._table, filter, set } as UpdateBuilder<T>;
  },
  count(typeHandle: TypeHandle, fn?: (ref: any) => { filter?: FilterExpr }): CountBuilder {
    const ref = makeRef(typeHandle._table, typeHandle._links);
    const filter = fn ? fn(ref).filter : undefined;
    return { kind: 'count', table: typeHandle._table, filter };
  },
  op(left: FieldRef, operator: OpExpr['operator'], right: unknown): OpExpr {
    return { kind: 'op', left, operator, right };
  },
  all(...exprs: FilterExpr[]): AllExpr { return { kind: 'all', exprs }; },
  any(...exprs: FilterExpr[]): AnyExpr { return { kind: 'any', exprs }; },
  neighbors<T>(nodeId: string, opts: { edgeKinds: string[] }): NeighborsBuilder<T> {
    return { kind: 'neighbors', nodeId, edgeKinds: opts.edgeKinds } as NeighborsBuilder<T>;
  },
  fts<T>(typeHandle: TypeHandle, query: string): FtsBuilder<T> {
    return { kind: 'fts', table: typeHandle._table, query } as FtsBuilder<T>;
  },
};

export default e;

// ── Internal helpers ────────────────────────────────────────────────
interface TypeHandle { _table: string; _links: readonly string[]; }
function makeRef(table: string, links: readonly string[]): Record<string, FieldRef> {
  const linkSet = new Set(links);
  return new Proxy({} as Record<string, FieldRef>, {
    // Link fields resolve to the FK column name (e.g. parent → parent_id).
    get(_, prop: string) {
      const column = linkSet.has(prop) ? `${prop}_id` : prop;
      return { kind: 'field', table, column };
    },
  });
}