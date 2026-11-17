import { BaseRepository } from "./base-repository.js";

export class PartRepository extends BaseRepository {
  constructor(db = null) {
    super("parts", db);
  }

  async listByProject(projectId, limit = 50, offset = 0) {
    return this.query.where({ project_id: projectId }).limit(limit).offset(offset);
  }
}
