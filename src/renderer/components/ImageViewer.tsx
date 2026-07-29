import type { MessagePicture } from '@shared/types'
import type PhotoSwipe from 'photoswipe'
import type { UIElementData } from 'photoswipe'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Gallery, Item as GalleryItem } from 'react-photoswipe-gallery'
import platform from '@/platform'

const DOWNLOAD_ICON = {
  isCustomSVG: true,
  inner: '<path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" id="pswp__icn-download"/>',
  outlineID: 'pswp__icn-download',
} as const

export type FetchPictureBlob = (storageKey: string) => Promise<string | null>

const fetchPictureBlob: FetchPictureBlob = async (storageKey) => {
  const { default: storage } = await import('@/storage')
  return storage.getBlob(storageKey).catch(() => null)
}

export async function downloadPicture(
  picture: MessagePicture,
  fetchBlob: FetchPictureBlob = fetchPictureBlob
): Promise<void> {
  if (picture.storageKey) {
    const base64 = await fetchBlob(picture.storageKey)
    if (!base64) return

    // Android cannot save names containing colons and silently ignores duplicate names.
    const filename =
      platform.type === 'mobile'
        ? `${picture.storageKey.replaceAll(':', '_')}_${Math.random().toString(36).substring(7)}`
        : picture.storageKey
    await platform.exporter.exportImageFile(filename, base64)
    return
  }

  if (!picture.url) return

  const basename = `image_${Math.random().toString(36).substring(7)}`
  if (picture.url.startsWith('data:image/')) {
    await platform.exporter.exportImageFile(basename, picture.url)
    return
  }
  await platform.exporter.exportByUrl(basename, picture.url)
}

function pictureFromActiveSlide(pswp: PhotoSwipe): MessagePicture | undefined {
  const src = pswp.currSlide?.data.src
  return typeof src === 'string' && src ? { url: src } : undefined
}

export function ImageViewer({ children, pictures }: { children: ReactNode; pictures?: readonly MessagePicture[] }) {
  const { t } = useTranslation()
  const downloadLabel = String(t('Download'))
  const uiElements = useMemo<UIElementData[]>(
    () => [
      {
        name: 'custom-download-button',
        ariaLabel: downloadLabel,
        order: 9,
        isButton: true,
        html: DOWNLOAD_ICON,
        appendTo: 'bar',
        onClick: async (_e: MouseEvent, _el: HTMLElement, pswp: PhotoSwipe) => {
          const picture = pictures?.[pswp.currIndex] ?? pictureFromActiveSlide(pswp)
          if (picture) await downloadPicture(picture)
        },
      },
    ],
    [downloadLabel, pictures]
  )

  return <Gallery uiElements={uiElements}>{children}</Gallery>
}

export { GalleryItem as ImageViewerItem }
