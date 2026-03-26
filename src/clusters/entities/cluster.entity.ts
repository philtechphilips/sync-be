import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Exclude, Expose } from 'class-transformer';
import { User } from '../../auth/entities/user.entity';

export enum ClusterType {
  MYSQL = 'mysql',
  POSTGRES = 'postgres',
  MSSQL = 'mssql',
}

@Exclude()
@Entity('clusters')
export class Cluster {
  @Expose()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Expose()
  @Column({ type: 'text' })
  name: string;

  @Expose()
  @Column({
    type: 'enum',
    enum: ClusterType,
    default: ClusterType.MYSQL,
  })
  type: ClusterType;

  // Sensitive — never exposed to the client
  @Column({ type: 'text' })
  host: string;

  @Column({ default: 3306 })
  port: number;

  @Column({ type: 'text' })
  username: string;

  @Column({ type: 'text', nullable: true })
  password: string;

  @Column({ type: 'text' })
  database: string;

  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Expose()
  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Expose()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
