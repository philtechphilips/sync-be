import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { WorkspaceMember } from './workspace-member.entity';

@Entity({ name: 'workspaces' })
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'industry_type' })
  industry_type: string;

  @Column({ name: 'workspace_url', unique: true })
  @Index()
  workspace_url: string;

  @Column({ nullable: true, type: 'text' })
  description: string;

  @Column({ name: 'unique_key', unique: true })
  @Index()
  unique_key: string;

  @Column({ name: 'default_language', default: 'en' })
  default_language: string;

  @Column({ name: 'default_currency', default: 'USD' })
  default_currency: string;

  @Column({ name: 'default_timezone', default: 'UTC' })
  default_timezone: string;

  @Column({ default: 'light' })
  theme: string;

  @Column({ name: 'onboarding_plan', nullable: false, default: 'starter' })
  onboarding_plan: string;

  @Column({ name: 'created_by', nullable: true })
  created_by: string;

  @Column({ name: 'can_invite_teammates', default: false })
  can_invite_teammates: boolean;

  @Column({ name: 'can_manage_settings', default: false })
  can_manage_settings: boolean;

  @Column({ name: 'can_view_analytics', default: false })
  can_view_analytics: boolean;

  @OneToMany(() => WorkspaceMember, (member) => member.workspace, {
    cascade: true,
  })
  members: WorkspaceMember[];

  @CreateDateColumn({ name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at: Date;
}
