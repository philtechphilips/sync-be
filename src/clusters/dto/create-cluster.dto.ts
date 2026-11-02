import {
  IsString,
  IsEnum,
  IsInt,
  IsOptional,
  IsBoolean,
  IsIn,
  Min,
  Max,
  MaxLength,
  ValidateIf,
  IsNotEmpty,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';
import { ClusterType, ClusterEnvironment } from '../entities/cluster.entity';
import { SSL_MODES, SslMode } from '../engine/types';

const isSqlite = (o: CreateClusterDto) => o.type === ClusterType.SQLITE;
/** Host and credentials are kept by the agent, not sent here. */
const viaAgent = (o: CreateClusterDto) => !!o.agentConnection;

export class CreateClusterDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @IsEnum(ClusterType)
  type: ClusterType;

  @IsEnum(ClusterEnvironment)
  @IsOptional()
  environment?: ClusterEnvironment;

  @IsString()
  @IsOptional()
  @MaxLength(32)
  color?: string;

  /** Hostname, or the database file path for SQLite. */
  @ValidateIf((o: CreateClusterDto) => !viaAgent(o))
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  host: string;

  @ValidateIf(
    (o: CreateClusterDto) =>
      !viaAgent(o) && (!isSqlite(o) || o.port !== undefined),
  )
  @Transform(({ value }) =>
    value === null || value === '' ? undefined : value,
  )
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @ValidateIf((o: CreateClusterDto) => !isSqlite(o) && !viaAgent(o))
  @IsString()
  @MaxLength(255)
  username: string;

  @IsString()
  @IsOptional()
  @MaxLength(1024)
  password?: string;

  @ValidateIf((o: CreateClusterDto) => !isSqlite(o) && !viaAgent(o))
  @IsString()
  @MaxLength(255)
  database: string;

  @IsBoolean()
  @IsOptional()
  isLocal?: boolean;

  @IsIn(SSL_MODES)
  @IsOptional()
  sslMode?: SslMode;

  @IsOptional()
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/, {
    message:
      'agentConnection must be the name of a connection saved with `synqdb-agent add`',
  })
  agentConnection?: string | null;
}

export class UpdateClusterDto extends PartialType(CreateClusterDto) {}
