import { Button, createTheme, type MantineColorsTuple } from '@mantine/core';

// Красная шкала Альфы (core-components, bluetint): кнопки — индекс 7, наведение — 8, #ef3124 — метки и фокус.
const alfa: MantineColorsTuple = [
  '#ffebeb',
  '#ffdfdf',
  '#f9ccca',
  '#f3b6af',
  '#ff755e',
  '#ff4837',
  '#ef3124',
  '#e32a17',
  '#d72505',
  '#c41400',
];

// Нейтральная шкала Альфы. Индекс 6 — «dimmed» в Mantine.
const gray: MantineColorsTuple = [
  '#f7f7f8',
  '#f2f3f5',
  '#edeef0',
  '#e7e8eb',
  '#d2d3d9',
  '#babbc2',
  '#5f5f66',
  '#4b4b51',
  '#3f3f45',
  '#212124',
];

const ui = "'Onest', 'Segoe UI', sans-serif";
const display = "'Geologica', 'Onest', sans-serif";

// Поля: подпись внутри поля, подсказка и ошибка — под ним (классы в styles.css).
const field = { classNames: { root: 'potok-field' }, inputWrapperOrder: ['label', 'input', 'description', 'error'] as const };

export const theme = createTheme({
  primaryColor: 'alfa',
  primaryShade: 7,
  colors: { alfa, brand: alfa, gray },
  black: '#212124',
  fontFamily: ui,
  fontFamilyMonospace: ui,
  headings: {
    fontFamily: display,
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '32px', lineHeight: '1.2' },
      h2: { fontSize: '24px', lineHeight: '1.2' },
      h3: { fontSize: '20px', lineHeight: '1.3' },
      h4: { fontSize: '18px', lineHeight: '1.35' },
      h5: { fontSize: '16px', lineHeight: '1.4' },
    },
  },
  fontSizes: { xs: '12px', sm: '14px', md: '16px', lg: '18px', xl: '20px' },
  lineHeights: { xs: '1.5', sm: '1.5', md: '1.5', lg: '1.45', xl: '1.4' },
  defaultRadius: 'md',
  radius: { xs: '6px', sm: '8px', md: '12px', lg: '24px', xl: '32px' },
  shadows: {
    xs: 'none',
    sm: 'none',
    md: '0 20px 24px rgba(0, 0, 0, 0.08), 0 12px 16px rgba(0, 0, 0, 0.04), 0 4px 8px rgba(0, 0, 0, 0.04), 0 0 1px rgba(0, 0, 0, 0.04)',
    lg: '0 24px 32px rgba(0, 0, 0, 0.08), 0 20px 24px rgba(0, 0, 0, 0.08), 0 12px 16px rgba(0, 0, 0, 0.04), 0 0 1px rgba(0, 0, 0, 0.04)',
  },
  components: {
    Card: { defaultProps: { radius: 'lg', padding: 'lg', shadow: 'none' } },
    Paper: { defaultProps: { radius: 'lg' } },
    Button: Button.extend({
      defaultProps: { radius: 'md' },
      vars: (_theme, props) => ({
        root: {
          '--button-height': props.size === 'lg' ? '56px' : props.size === 'md' || !props.size ? '48px' : undefined,
          '--button-fz': props.size === 'lg' || props.size === 'md' || !props.size ? '16px' : undefined,
        },
      }),
      styles: { root: { fontWeight: 500 } },
    }),
    Badge: { defaultProps: { radius: 'xs' }, styles: { root: { textTransform: 'none', fontWeight: 500, letterSpacing: 0 } } },
    TextInput: { defaultProps: field },
    NumberInput: { defaultProps: { ...field, hideControls: true } },
    Select: { defaultProps: field },
    Textarea: { defaultProps: field },
    PasswordInput: { defaultProps: field },
    Modal: { defaultProps: { radius: 'lg', centered: true } },
    Menu: { defaultProps: { radius: 'lg', shadow: 'md' } },
    Popover: { defaultProps: { radius: 'lg', shadow: 'md' } },
    Tooltip: { defaultProps: { radius: 'md' } },
    SegmentedControl: { defaultProps: { radius: 'md', color: 'dark' } },
    Checkbox: { defaultProps: { radius: 'xs', color: 'dark' } },
    Radio: { defaultProps: { color: 'dark' } },
    Slider: { defaultProps: { color: 'dark', size: 'sm' } },
    Loader: { defaultProps: { color: 'gray' } },
    Notification: { defaultProps: { radius: 'lg' } },
  },
});

export const BRAND = {
  name: 'Поток',
  caption: 'Кредиты для бизнеса',
};
