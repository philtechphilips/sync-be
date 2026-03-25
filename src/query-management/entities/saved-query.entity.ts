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
import { Collection } from './collection.entity';
import { Cluster } from '../../clusters/entities/cluster.entity';

@Entity('saved_queries')
export class SavedQuery {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ type: 'text' })
  query: string;

  @Column({ name: 'clusterId', nullable: true })
  clusterId: string;

  @ManyToOne(() => Cluster, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'clusterId' })
  cluster: Cluster;

  @Column({ name: 'userId' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({ nullable: true, name: 'collectionId' })
  collectionId: string;

  @ManyToOne(() => Collection, (collection) => collection.queries, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'collectionId' })
  collection: Collection;

  @Column({ type: 'simple-array', nullable: true })
  tags: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
