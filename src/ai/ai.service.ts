import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import { ClustersService } from '../clusters/clusters.service';
import { ClusterType } from '../clusters/entities/cluster.entity';
import { config } from '../config/config.service';

// Keeps prompts inside the model's context window for very large schemas.
const MAX_SCHEMA_CHARS = 60_000;

@Injectable()
export class AIService {
  private client: OpenAI | null = null;

  constructor(private readonly clustersService: ClustersService) {}

  private get openai(): OpenAI {
    if (!config.OPENAI_API_KEY) {
      throw new ServiceUnavailableException(
        'AI features are not configured on this server.',
      );
    }
    this.client ??= new OpenAI({ apiKey: config.OPENAI_API_KEY });
    return this.client;
  }

  private getSQLSystemPrompt(clusterType: ClusterType): string {
    if (clusterType === ClusterType.MSSQL) {
      return `You are a professional T-SQL (Microsoft SQL Server) expert. Generate valid T-SQL code based on the provided schema. Only return raw SQL — no explanations, no markdown, no code fences.
STRICT T-SQL RULES — never violate these:
- Use GETDATE() instead of NOW()
- Use MONTH(GETDATE()), YEAR(GETDATE()), DAY(GETDATE()) instead of EXTRACT(... FROM ...)
- Use TOP N instead of LIMIT N
- Use DATEADD / DATEDIFF for date arithmetic
- Use ISNULL() instead of COALESCE where single-arg fallback is needed
- Never use PostgreSQL or MySQL-only functions`;
    }
    if (clusterType === ClusterType.POSTGRES) {
      return `You are a professional PostgreSQL expert. Generate valid PostgreSQL code based on the provided schema. Only return raw SQL — no explanations, no markdown, no code fences.
STRICT PostgreSQL RULES — never violate these:
- Use NOW() or CURRENT_TIMESTAMP for current time
- Use EXTRACT(PART FROM timestamp) for date parts
- Use LIMIT N instead of TOP N
- Never use T-SQL or MySQL-only functions`;
    }
    return `You are a professional SQL expert for ${clusterType}. Generate valid SQL code based on the provided schema. Only return raw SQL — no explanations, no markdown, no code fences.`;
  }

  async generateSQL(clusterId: string, userId: string, prompt: string) {
    const cluster = await this.clustersService.findOne(clusterId, userId);
    const rawSchema = await this.clustersService.getSchema(clusterId, userId);
    const compactSchema = this.getCompressedSchema(rawSchema);

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: this.getSQLSystemPrompt(cluster.type),
        },
        {
          role: 'user',
          content: `Schema: ${compactSchema}\n\nObjective: "${prompt}"`,
        },
      ],
    });

    return response.choices[0].message.content
      ?.trim()
      .replaceAll(/```sql|```/g, '');
  }

  async *generateSQLStream(
    clusterId: string,
    userId: string,
    prompt: string,
    signal?: AbortSignal,
  ) {
    const cluster = await this.clustersService.findOne(clusterId, userId);
    const rawSchema = await this.clustersService.getSchema(clusterId, userId);
    const compactSchema = this.getCompressedSchema(rawSchema);

    const stream = await this.openai.chat.completions.create(
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: this.getSQLSystemPrompt(cluster.type),
          },
          {
            role: 'user',
            content: `Schema: ${compactSchema}\n\nObjective: "${prompt}"`,
          },
        ],
        stream: true,
      },
      { signal },
    );

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        yield content.replaceAll(/```sql|```/g, '');
      }
    }
  }

  async explainSQL(
    clusterId: string,
    userId: string,
    sql: string,
    mode: 'simple' | 'advanced',
  ) {
    const cluster = await this.clustersService.findOne(clusterId, userId);

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a database consultant for ${cluster.type === ClusterType.MSSQL ? 'SQL Server (T-SQL)' : cluster.type}. Explain the provided SQL query in ${mode} terms. ${mode === 'simple' ? 'Avoid technical jargon.' : 'Include technical details like joins and aggregation logic.'}`,
        },
        {
          role: 'user',
          content: `Query: ${sql}`,
        },
      ],
    });

    return response.choices[0].message.content;
  }

  async optimizeSQL(clusterId: string, userId: string, sql: string) {
    const cluster = await this.clustersService.findOne(clusterId, userId);
    const rawSchema = await this.clustersService.getSchema(clusterId, userId);
    const compactSchema = this.getCompressedSchema(rawSchema);

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a database performance tuner for ${cluster.type === ClusterType.MSSQL ? 'SQL Server (T-SQL)' : cluster.type}. Suggest query optimizations and indexing strategies. Use only syntax valid for ${cluster.type === ClusterType.MSSQL ? 'T-SQL (GETDATE, DATEADD, TOP, etc.)' : cluster.type}. Be concise and technical.`,
        },
        {
          role: 'user',
          content: `Schema: ${compactSchema}\n\nQuery to optimize: ${sql}`,
        },
      ],
    });

    return response.choices[0].message.content;
  }

  /**
   * Compresses the flat schema list into a token-efficient text format.
   * Maps tableName to a concise list of columns and their types.
   */
  private getCompressedSchema(rawSchema: Array<Record<string, any>>): string {
    const tables: Record<string, string[]> = {};
    const fks: string[] = [];

    rawSchema.forEach((row) => {
      const table = row.tableName;
      if (!tables[table]) tables[table] = [];
      tables[table].push(`${row.name}(${row.type})`);

      if (row.referencedTable) {
        fks.push(
          `${table}.${row.name} -> ${row.referencedTable}.${row.referencedColumn}`,
        );
      }
    });

    const text =
      Object.entries(tables)
        .map(([name, cols]) => `Table ${name} [${cols.join(', ')}]`)
        .join('; ') + (fks.length > 0 ? ` | Relations: ${fks.join(', ')}` : '');
    return text.length > MAX_SCHEMA_CHARS
      ? `${text.slice(0, MAX_SCHEMA_CHARS)} … (schema truncated)`
      : text;
  }
}
