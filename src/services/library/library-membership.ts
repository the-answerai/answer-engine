import { z } from 'zod';

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const FilterConditionSchema = z.object({
  field: z.string().refine((field) => (
    field === 'content_type'
    || field === 'source'
    || field === 'created_at'
    || field === 'tag'
    || /^metadata\.[A-Za-z0-9_-]{1,64}$/.test(field)
    || /^analysis\.[A-Za-z0-9_-]{1,64}$/.test(field)
  ), 'Unsupported library filter field'),
  operator: z.enum(['eq', 'in', 'contains', 'gte', 'lte']),
  value: z.union([ScalarSchema, z.array(ScalarSchema).min(1).max(100)]),
}).strict().superRefine((condition, context) => {
  const isArray = Array.isArray(condition.value);
  if (condition.operator === 'in' && !isArray) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'in requires an array value' });
  }
  if (condition.operator !== 'in' && isArray) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${condition.operator} requires a scalar value` });
  }
  if (condition.field === 'created_at' && !['gte', 'lte'].includes(condition.operator)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'created_at supports gte and lte' });
  }
  if (condition.field === 'created_at'
      && !z.string().datetime().safeParse(condition.value).success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'created_at requires an ISO date-time' });
  }
  if (condition.field === 'tag' && !['eq', 'in'].includes(condition.operator)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'tag supports eq and in' });
  }
  if (['content_type', 'source'].includes(condition.field)
      && !['eq', 'in', 'contains'].includes(condition.operator)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${condition.field} does not support ${condition.operator}` });
  }
  if (['content_type', 'source', 'tag'].includes(condition.field)) {
    const values = Array.isArray(condition.value) ? condition.value : [condition.value];
    if (values.some((value) => typeof value !== 'string')) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${condition.field} requires text values` });
    }
    if (condition.field === 'content_type') {
      const contentTypes = z.enum(['call', 'document', 'ticket', 'domain', 'chat', 'page']);
      if (values.some((value) => !contentTypes.safeParse(value).success)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsupported content type' });
      }
    }
  }
  if ((condition.field.startsWith('metadata.') || condition.field.startsWith('analysis.'))
      && !['eq', 'contains'].includes(condition.operator)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'JSON fields support eq and contains' });
  }
});

export const LibraryFilterSchema = z.object({
  operator: z.enum(['and', 'or']).default('and'),
  conditions: z.array(FilterConditionSchema).min(1).max(25),
}).strict();

export type LibraryFilter = z.infer<typeof LibraryFilterSchema>;

interface MembershipInput {
  readonly contentAlias: string;
  readonly tenantParameter: number;
  readonly libraryParameter: number;
  readonly filter: LibraryFilter | null;
  readonly parameters: unknown[];
}

function bind(parameters: unknown[], value: unknown, cast = ''): string {
  parameters.push(value);
  return `$${parameters.length}${cast}`;
}

function compileCondition(
  alias: string,
  condition: LibraryFilter['conditions'][number],
  parameters: unknown[],
): string {
  if (condition.field === 'tag') {
    const value = condition.operator === 'in'
      ? bind(parameters, condition.value, '::text[]')
      : bind(parameters, condition.value);
    const comparison = condition.operator === 'in' ? `t.slug = ANY(${value})` : `t.slug = ${value}`;
    return `EXISTS (
      SELECT 1 FROM content_tags ct
      JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
      WHERE ct.tenant_id = ${alias}.tenant_id AND ct.content_id = ${alias}.id
        AND t.is_active = true AND ${comparison}
    )`;
  }

  if (condition.field === 'created_at') {
    const value = bind(parameters, condition.value, '::timestamptz');
    return `${alias}.created_at ${condition.operator === 'gte' ? '>=' : '<='} ${value}`;
  }

  let expression: string;
  if (condition.field.startsWith('metadata.') || condition.field.startsWith('analysis.')) {
    const [namespace, key] = condition.field.split('.', 2) as [string, string];
    const column = namespace === 'metadata' ? 'metadata' : 'analysis_data';
    expression = `${alias}.${column} ->> ${bind(parameters, key)}`;
  } else {
    expression = `${alias}.${condition.field}`;
  }

  if (condition.operator === 'in') {
    return `${expression} = ANY(${bind(parameters, condition.value, '::text[]')})`;
  }
  if (condition.operator === 'contains') {
    return `${expression} ILIKE '%' || ${bind(parameters, String(condition.value))} || '%'`;
  }
  return `${expression} = ${bind(parameters, String(condition.value))}`;
}

export function buildEffectiveMembership(input: MembershipInput): string {
  const filterSql = input.filter
    ? `(${input.filter.conditions.map((condition) => compileCondition(
      input.contentAlias,
      condition,
      input.parameters,
    )).join(input.filter.operator === 'and' ? ' AND ' : ' OR ')})`
    : 'TRUE';
  const tenant = `$${input.tenantParameter}`;
  const library = `$${input.libraryParameter}`;
  return `(
    (${filterSql} OR EXISTS (
      SELECT 1 FROM library_manual_includes lmi
      WHERE lmi.tenant_id = ${tenant}
        AND lmi.library_id = ${library}::uuid
        AND lmi.content_id = ${input.contentAlias}.id
    ))
    AND NOT EXISTS (
      SELECT 1 FROM library_manual_excludes lme
      WHERE lme.tenant_id = ${tenant}
        AND lme.library_id = ${library}::uuid
        AND lme.content_id = ${input.contentAlias}.id
    )
  )`;
}
