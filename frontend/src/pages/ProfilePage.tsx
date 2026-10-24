import { Button, Text, Title } from '@mantine/core';
import { Link } from 'react-router';

import { useAuth } from '../auth/AuthContext';
import { CompanyCard } from '../components/Side';
import { nb } from '../lib/nobreak';

/**
 * Профиль — данные учётной записи из /me: кто вошёл, роль, право подписи и компания. Изменить их в демо нельзя:
 * учётные записи заданы стендом. Последние уведомления — на главной и под колокольчиком, здесь их не повторяем.
 */
export function ProfilePage() {
  const { user, signOut } = useAuth();
  if (!user) return null;
  const analyst = user.role === 'analyst';
  const access = (
    <section className="potok-panel">
      <Title order={3}>Уведомления и вход</Title>
      <ul className="potok-rows">
        <li className="potok-side-row">
          <b>Уведомления — только в кабинете</b>
          <span>SMS и почта в демо не используются; коды подписи показываются в окне подписания</span>
        </li>
        <li className="potok-side-row">
          <b>Сессия — только в этой вкладке</b>
          <span>Вход хранится до закрытия вкладки; в соседней вкладке можно войти под другим профилем</span>
        </li>
      </ul>
      <div className="potok-cta" style={{ marginTop: 16 }}>
        <Button variant="default" size="md" onClick={signOut}>
          Выйти
        </Button>
        {!analyst && (
          <Button component={Link} to="/applications" variant="subtle" size="md">
            Мои заявки
          </Button>
        )}
      </div>
    </section>
  );
  return (
    <div className="potok-col">
      <div>
        <Title order={1}>{user.full_name}</Title>
        <Text c="dimmed" mt={4}>
          {user.position}
          {user.company ? `, ${user.company.short_name}` : analyst ? ', банк' : ''}
        </Text>
      </div>
      {/* Справа — компания; у аналитика её нет, и справа встаёт блок входа. */}
      <div className="potok-below">
        <div className="potok-col">
          <section className="potok-panel">
            <Title order={3}>Учётная запись</Title>
            <dl className="potok-kv">
              <div>
                <dt>Почта</dt>
                {/* Перенос после «@»: в две колонки на телефоне почта целиком не помещается. */}
                <dd>
                  {user.email.split('@')[0]}@<wbr />
                  {user.email.split('@').slice(1).join('@')}
                </dd>
              </div>
              <div>
                <dt>Роль</dt>
                <dd>{analyst ? 'Кредитный аналитик банка' : 'Клиент банка'}</dd>
              </div>
              {!analyst && (
                <div>
                  <dt>Право подписи</dt>
                  <dd>{user.can_sign ? 'Подписывает договоры' : 'Готовит заявки, подписывает руководитель'}</dd>
                </div>
              )}
            </dl>
            {!analyst && !user.can_sign && user.company?.director && (
              <div className="potok-inline-note">
                Принять предложение и подписать договор может руководитель компании — {nb(user.company.director)}. Заявки
                можно готовить и отправлять, а предложение — передать ему на подпись.
              </div>
            )}
          </section>
          {user.company && access}
        </div>
        <div className="potok-col">{user.company ? <CompanyCard company={user.company} /> : access}</div>
      </div>
    </div>
  );
}
