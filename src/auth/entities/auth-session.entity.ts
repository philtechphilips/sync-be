import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * One row per signed-in browser. The refresh token is `<id>.<secret>`; only
 * a SHA-256 of the secret is stored.
 */
@Entity({ name: 'auth_sessions' })
export class AuthSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ type: 'char', length: 64 })
  tokenHash: string;

  /** Previous token, still accepted briefly so parallel tabs don't log out. */
  @Column({ type: 'char', length: 64, nullable: true })
  previousTokenHash: string | null;

  @Column({ type: 'datetime', nullable: true })
  rotatedAt: Date | null;

  @Column({ type: 'datetime' })
  expiresAt: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
