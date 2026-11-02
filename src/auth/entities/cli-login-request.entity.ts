import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A pending `synqdb-agent login`. Stored in the database (not in memory) so
 * every API instance can see it. The id is a SHA-256 of the login token.
 */
@Entity({ name: 'cli_login_requests' })
export class CliLoginRequest {
  @PrimaryColumn({ type: 'char', length: 64 })
  id: string;

  @Column({ type: 'varchar', length: 16 })
  userCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  hostname: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: 'pending' | 'authorized' | 'denied';

  @Column({ type: 'varchar', length: 36, nullable: true })
  userId: string | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'datetime' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
