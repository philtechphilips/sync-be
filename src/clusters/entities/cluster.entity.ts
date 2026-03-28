import { Entity, Column } from 'typeorm';
import { Exclude, Expose } from 'class-transformer';
import { UserOwnedEntity } from '../../common/entities/user-owned.entity';

export enum ClusterType {
  MYSQL = 'mysql',
  POSTGRES = 'postgres',
  MSSQL = 'mssql',
}

export enum ClusterEnvironment {
  DEVELOPMENT = 'development',
  STAGING = 'staging',
  PRODUCTION = 'production',
}

@Exclude()
@Entity('clusters')
export class Cluster extends UserOwnedEntity {
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

  @Expose()
  @Column({
    type: 'enum',
    enum: ClusterEnvironment,
    default: ClusterEnvironment.DEVELOPMENT,
  })
  environment: ClusterEnvironment;

  @Expose()
  @Column({ type: 'text', nullable: true })
  color: string;
}
