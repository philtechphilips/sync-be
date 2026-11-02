import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentService } from '../../agent/agent.service';
import { ClusterType } from '../entities/cluster.entity';
import { ConnectionManager } from './connection-manager';
import { splitEachStatement } from './sql-splitter';
import {
  ConnectionTarget,
  PageResult,
  RunResult,
  ScriptResult,
  Statement,
  TxHandle,
  ValueKind,
} from './types';

/**
 * Single entry point for running SQL against a user's database. Local
 * clusters go through the agent, everything else through direct pools, so
 * every feature (restore, sync, paging...) works the same way for both.
 */
@Injectable()
export class DbExecutor {
  constructor(
    private readonly direct: ConnectionManager,
    private readonly agent: AgentService,
  ) {}

  private check(t: ConnectionTarget) {
    if (t.type === ClusterType.SQLITE && !t.isLocal) {
      throw new BadRequestException(
        'SQLite databases must be connected as a local database through the synqdb-agent.',
      );
    }
  }

  run(
    t: ConnectionTarget,
    sql: string,
    params: unknown[] = [],
    kinds: (ValueKind | null)[] = [],
  ): Promise<RunResult> {
    this.check(t);
    return t.isLocal
      ? this.agent.run(t, sql, params, kinds)
      : this.direct.run(t, sql, params, kinds);
  }

  runStatement(t: ConnectionTarget, s: Statement): Promise<RunResult> {
    return this.run(t, s.sql, s.params, s.paramKinds);
  }

  async runScript(t: ConnectionTarget, sql: string): Promise<ScriptResult> {
    this.check(t);
    if (t.type === ClusterType.SQLITE) {
      // SQLite runs one statement per call, so split the script here.
      const out: ScriptResult = { results: [], rowCounts: [] };
      for (const s of splitEachStatement(sql, t.type)) {
        const res = await this.agent.runScript(t, s.text);
        out.results.push(...res.results);
        out.rowCounts.push(...res.rowCounts);
      }
      return out;
    }
    return t.isLocal
      ? this.agent.runScript(t, sql)
      : this.direct.runScript(t, sql);
  }

  runPage(
    t: ConnectionTarget,
    sql: string,
    offset: number,
    limit: number,
  ): Promise<PageResult> {
    this.check(t);
    return t.isLocal
      ? this.agent.runPage(t, sql, offset, limit)
      : this.direct.runPage(t, sql, offset, limit);
  }

  transaction<T>(
    t: ConnectionTarget,
    fn: (tx: TxHandle) => Promise<T>,
  ): Promise<T> {
    this.check(t);
    return t.isLocal
      ? this.agent.transaction(t, fn)
      : this.direct.transaction(t, fn);
  }

  test(t: ConnectionTarget): Promise<void> {
    this.check(t);
    return t.isLocal ? this.agent.test(t) : this.direct.test(t);
  }

  invalidate(clusterId: string) {
    return this.direct.invalidate(clusterId);
  }
}
