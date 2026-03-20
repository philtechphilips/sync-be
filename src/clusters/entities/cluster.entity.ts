import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum ClusterType {
  MYSQL = 'mysql',
  POSTGRES = 'postgres',
}

@Entity('clusters')
export class Cluster {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: ClusterType,
    default: ClusterType.MYSQL,
  })
  type: ClusterType;

  @Column()
  host: string;

  @Column({ default: 3306 })
  port: number;

  @Column()
  username: string;

  @Column({ type: 'text', nullable: true })
  password: string;

  @Column()
  database: string;

  @Column()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
