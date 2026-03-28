import { Entity, Column, ManyToOne, JoinColumn } from 'typeorm';
import { UserOwnedEntity } from '../../common/entities/user-owned.entity';
import { Collection } from './collection.entity';
import { Cluster } from '../../clusters/entities/cluster.entity';

@Entity('saved_queries')
export class SavedQuery extends UserOwnedEntity {
  @Column()
  name: string;

  @Column({ type: 'text' })
  query: string;

  @Column({ name: 'clusterId', nullable: true })
  clusterId: string;

  @ManyToOne(() => Cluster, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'clusterId' })
  cluster: Cluster;

  @Column({ nullable: true, name: 'collectionId' })
  collectionId: string;

  @ManyToOne(() => Collection, (collection) => collection.queries, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'collectionId' })
  collection: Collection;

  @Column({ type: 'simple-array', nullable: true })
  tags: string[];
}
