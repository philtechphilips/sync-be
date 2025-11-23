import {
  Column,
  Entity,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

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

  @Column({ nullable: true })
  access_token: string;

  @Column({ nullable: true })
  refresh_token: string;

  @Column({ type: 'timestamp', nullable: true })
  refresh_token_expiry: Date;

  @Column({ nullable: true })
  profile_picture: string;

  @Column({ nullable: true, default: 'local' })
  provider: string;

  @Column({ nullable: true })
  google_id: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
