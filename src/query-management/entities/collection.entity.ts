import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { SavedQuery } from './saved-query.entity';

@Entity('collections')
export class Collection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'userId' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'userId' })
  user: User;

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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
