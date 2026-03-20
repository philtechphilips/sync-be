import { IsString, IsEnum, IsNumber, IsOptional } from 'class-validator';
import { ClusterType } from '../entities/cluster.entity';

export class CreateClusterDto {
  @IsString()
  name: string;

  @IsEnum(ClusterType)
  type: ClusterType;

  @IsString()
  host: string;

  @IsNumber()
  port: number;

  @IsString()
  username: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  database: string;
}
