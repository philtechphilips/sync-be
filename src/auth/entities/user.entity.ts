import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { Exclude, Expose } from 'class-transformer';
import { Cluster } from '../../clusters/entities/cluster.entity';

@Exclude()
@Entity({ name: 'auth_users' })
export class User {
  @Expose()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose()
  @Column({ nullable: true })
  full_name: string;

  @Expose()
  @Column()
  email: string;

  @Expose()
  @Column({ default: 'user' })
  role: string;

  @Expose()
  @Column({ type: 'text', nullable: true })
  profile_picture: string;

  // Sensitive — never exposed to the client
  @Column({ default: true })
  requires_password: boolean;

  @Column({ nullable: true })
  password: string;

  @Column({ type: 'text', nullable: true })
  access_token: string;

  @Column({ type: 'text', nullable: true })
  refresh_token: string;

  @Column({ type: 'timestamp', nullable: true })
  refresh_token_expiry: Date;

  @Column({ nullable: true, default: 'local' })
  provider: string;

  @Column({ nullable: true })
  google_id: string;

  @OneToMany(() => Cluster, (cluster) => cluster.user)
  clusters: Cluster[];

  @Expose()
  @Column({ type: 'simple-json', nullable: true })
  settings: Record<string, any>;

  // NOT @Expose() — never serialised into REST responses
  @Column({ type: 'varchar', length: 64, nullable: true, unique: true })
  agentKey: string | null;

  @Expose()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Expose()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
