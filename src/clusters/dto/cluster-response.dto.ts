import { ClusterType } from '../entities/cluster.entity';

export class ClusterResponseDto {
  id: string;
  name: string;
  type: ClusterType;
  createdAt: Date;
  updatedAt: Date;
}
