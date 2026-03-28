import { Entity, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { UserOwnedEntity } from '../../common/entities/user-owned.entity';
import { SavedQuery } from './saved-query.entity';

@Entity('collections')
export class Collection extends UserOwnedEntity {
  @Column()
  name: string;

  @Column({ nullable: true, name: 'parentId' })
  parentId: string;

  @ManyToOne(() => Collection, (collection) => collection.children, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'parentId' })
  parent: Collection;

  @OneToMany(() => Collection, (collection) => collection.parent)
  children: Collection[];

  @OneToMany('SavedQuery', 'collection')
  queries: SavedQuery[];
}
