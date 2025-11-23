import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Workspace } from './workspace.entity';
import { User } from '../../auth/entities/user.entity';

@Entity({ name: 'workspace_members' })
export class WorkspaceMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspace_id: string;

  @ManyToOne(() => Workspace, (workspace) => workspace.members, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @Column({ name: 'user_id', nullable: true })
  @Index()
  user_id: string;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column()
  email: string;

  @Column({ default: 'member' })
  role: string;

  @Column({ name: 'invitation_token', nullable: true, unique: true })
  @Index()
  invitation_token: string;

  @Column({ name: 'invitation_sent_at', nullable: true, type: 'timestamp' })
  invitation_sent_at: Date;

  @Column({ name: 'invitation_accepted_at', nullable: true, type: 'timestamp' })
  invitation_accepted_at: Date;

  @Column({ name: 'invitation_expires_at', nullable: true, type: 'timestamp' })
  invitation_expires_at: Date;

  @CreateDateColumn({ name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at: Date;
}
