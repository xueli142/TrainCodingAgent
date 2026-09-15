import { z } from 'zod'

export function jsonSchemaOf<T>(schema: z.ZodType<T>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  delete json.$schema
  return json
}
