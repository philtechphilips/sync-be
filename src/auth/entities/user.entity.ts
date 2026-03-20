import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Cluster } from '../../clusters/entities/cluster.entity';

@Entity({ name: 'auth_users' })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  full_name: string;

  @Column({ default: true })
  requires_password: boolean;

  @Column({ nullable: true })
  password: string;

  @Column()
  email: string;

  @Column({ default: 'user' })
  role: string;

  @Column({ type: 'text', nullable: true })
  access_token: string;

  @Column({ type: 'text', nullable: true })
  refresh_token: string;

  @Column({ type: 'timestamp', nullable: true })
  refresh_token_expiry: Date;

  @Column({ type: 'text', nullable: true })
  profile_picture: string;

  @Column({ nullable: true, default: 'local' })
  provider: string;

  @Column({ nullable: true })
  google_id: string;

  @OneToMany(() => Cluster, (cluster) => cluster.user)
  clusters: Cluster[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
