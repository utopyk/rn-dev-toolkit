import React from 'react';
import type { ProfileInfo } from '../types';
import './ProfileBanner.css';

interface ProfileBannerProps {
  profile: ProfileInfo;
}

export function ProfileBanner({ profile }: ProfileBannerProps) {
  return (
    <div className="profile-banner">
      <div className="profile-info">
        <span className="profile-label">V </span>
        <span className="profile-name">{profile.name}</span>
        <span className="profile-sep">|</span>
        <span className="profile-branch">{profile.branch}</span>
        <span className="profile-sep">|</span>
        <span>{profile.platform}</span>
        <span className="profile-sep">|</span>
        <span className={profile.dirty ? 'profile-dirty' : ''}>
          {profile.dirty ? 'dirty' : 'clean'}
        </span>
        <span className="profile-sep">|</span>
        <span>:{profile.port}</span>
        <span className="profile-sep">|</span>
        <span>{profile.buildType}</span>
      </div>
    </div>
  );
}
