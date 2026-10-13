'use client';

import Link from 'next/link';

import type { ArticleListItemDto } from '@/lib/api/dto';

import { FormatChips } from './FormatChips';
import { statusLabel } from './labels';
import { relativeTime } from './relative-time';

// The desk's article table (spec/ui.md §4): Title · Topic · Status · Formats · Updated.

export interface ArticleTableProps {
  articles: readonly ArticleListItemDto[];
  timeZone: string;
  now: Date;
}

export function ArticleTable({ articles, timeZone, now }: ArticleTableProps) {
  return (
    <div className="admin-tablewrap">
      <table className="data admin-table">
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Topic</th>
            <th scope="col">Status</th>
            <th scope="col">Formats</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {articles.map((a) => (
            <tr key={a.id}>
              <td className="admin-table__title">
                <Link href={`/admin/articles/${a.id}`}>{a.title || 'Untitled'}</Link>
                <span className="admin-table__slug mono">/p/{a.slug}</span>
              </td>
              <td>{a.topic ? <span className="tag">{a.topic}</span> : <span className="admin-faint">—</span>}</td>
              <td>
                <span className={`spill spill--${a.status}${a.hasUnpublishedChanges ? ' spill--changes' : ''}`}>
                  {statusLabel(a)}
                </span>
              </td>
              <td>
                <FormatChips formats={a.formats} />
              </td>
              <td className="admin-table__updated">
                <time dateTime={a.updatedAt} title={a.updatedAt}>
                  {relativeTime(a.updatedAt, now, timeZone)}
                </time>
                {a.updatedBy ? <span className="admin-faint"> by {a.updatedBy}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
